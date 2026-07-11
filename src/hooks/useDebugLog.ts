'use client';

import { useCallback, useRef, useState } from 'react';

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface DebugLogEntry {
  timestamp: string;
  level: LogLevel;
  step: string;
  message: string;
  details?: unknown;
}

export interface ConversionDebugInfo {
  userAgent: string;
  fileName: string | null;
  fileSize: number | null;
  fileMimeType: string | null;
  ffmpegLoadStatus: 'idle' | 'loading' | 'loaded' | 'error';
  coreJsLoadStatus: 'idle' | 'loading' | 'loaded' | 'error';
  wasmLoadStatus: 'idle' | 'loading' | 'loaded' | 'error';
  mediaAnalysisStatus: 'idle' | 'analyzing' | 'completed' | 'error';
  encoderValidationStatus: 'idle' | 'validating' | 'completed' | 'error';
  encoderValidationResult: { h264: boolean; aac: boolean } | null;
  fileWriteStatus: 'idle' | 'writing' | 'written' | 'error';
  ffmpegExecStartTime: number | null;
  lastProgressValue: number | null;
  lastLogLines: string[];
  errorCode: string | null;
  errorMessage: string | null;
  errorStack: string | null;
  elapsedTime: number;
  logs: DebugLogEntry[];
}

const MAX_LOG_ENTRIES = 100;
const MAX_LOG_LINES = 20;

function formatTimestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString('tr-TR', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
    fractionalSecondDigits: 3 
  });
}

// State mapping from log messages
function extractStateFromLog(step: string, message: string, level: LogLevel): Partial<ConversionDebugInfo> | null {
  const updates: Partial<ConversionDebugInfo> = {};

  // Debug logging
  if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
    console.debug('[DebugLog] extractStateFromLog:', { step, message: message.substring(0, 60), level });
  }

  // Error handling
  if (level === 'error') {
    if (step === 'FFmpeg' || step === 'Load' || step === 'Convert' || message.includes('FFmpeg')) {
      updates.ffmpegLoadStatus = 'error';
    }
    if (message.includes('WASM')) {
      updates.wasmLoadStatus = 'error';
    }
    if (step === 'Media' || message.includes('Medya') || message.includes('Media')) {
      updates.mediaAnalysisStatus = 'error';
    }
    if (message.includes('Encoder')) {
      updates.encoderValidationStatus = 'error';
    }
    if (step === 'Convert' || step === 'File' || message.includes('Dosya')) {
      updates.fileWriteStatus = 'error';
    }
    const result = Object.keys(updates).length > 0 ? updates : null;
    return result;
  }

  // ========== 'Load' step - handles CoreJS, WASM, FFmpeg, Encoder ==========
  if (step === 'Load') {
    // Core JS
    if (message.includes('Core JS')) {
      if (message.includes('yükleniyor')) {
        updates.coreJsLoadStatus = 'loading';
      }
      if (message.includes('yüklendi')) {
        updates.coreJsLoadStatus = 'loaded';
      }
    }
    
    // WASM
    if (message.includes('WASM')) {
      if (message.includes('yükleniyor')) {
        updates.wasmLoadStatus = 'loading';
      }
      if (message.includes('yüklendi')) {
        updates.wasmLoadStatus = 'loaded';
      }
    }
    
    // FFmpeg general loading
    if (message.includes('FFmpeg')) {
      if (message.includes('yükleniyor') || message.includes('yüklenirken')) {
        updates.ffmpegLoadStatus = 'loading';
      }
      if (message.includes('yüklendi') || message.includes('başarıyla')) {
        updates.ffmpegLoadStatus = 'loaded';
      }
    }
    
    // Encoder validation
    if (message.includes('Encoder') || message.includes('doğrulama')) {
      if (message.includes('başlatılıyor') || message.includes('yapılıyor')) {
        updates.encoderValidationStatus = 'validating';
      }
      if (message.includes('tamamlandı')) {
        updates.encoderValidationStatus = 'completed';
      }
    }
  }

  // ========== 'FFmpeg' step ==========
  if (step === 'FFmpeg') {
    if (message.includes('yükleniyor') || message.includes('yüklenirken')) {
      updates.ffmpegLoadStatus = 'loading';
    }
    if (message.includes('yüklendi') || message.includes('başarıyla')) {
      updates.ffmpegLoadStatus = 'loaded';
    }
  }

  // ========== 'Media' step ==========
  if (step === 'Media') {
    if (message.includes('başlatılıyor') || message.includes('starting') || message.includes('analyzing')) {
      updates.mediaAnalysisStatus = 'analyzing';
    }
    if (message.includes('tamamlandı') || message.includes('completed')) {
      updates.mediaAnalysisStatus = 'completed';
    }
  }

  // ========== 'Encoder' step ==========
  if (step === 'Encoder') {
    if (message.includes('doğrulama') || message.includes('validation') || message.includes('validating')) {
      updates.encoderValidationStatus = 'validating';
    }
    if (message.includes('tamamlandı') || message.includes('completed')) {
      updates.encoderValidationStatus = 'completed';
    }
  }

  // ========== 'Convert' / 'File' step ==========
  if (step === 'Convert' || step === 'File') {
    if (message.includes('başlatılıyor') || message.includes('starting') || message.includes('okunuyor') || message.includes('EXEC_STARTED')) {
      updates.fileWriteStatus = 'writing';
    }
    if (message.includes('tamamlandı') || message.includes('complete') || message.includes('EXEC_SUCCESS') || message.includes('OUTPUT_READ_SUCCESS')) {
      updates.fileWriteStatus = 'written';
    }
  }

  // Check for specific success markers in any message
  if (message.includes('WRITE_FILE_SUCCESS') || message.includes('OUTPUT_READ_SUCCESS') || message.includes('CONVERSION_COMPLETE')) {
    updates.fileWriteStatus = 'written';
  }

  const result = Object.keys(updates).length > 0 ? updates : null;
  if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
    console.debug('[DebugLog] State updates:', result);
  }
  return result;
}

interface UseDebugLogReturn {
  debugInfo: ConversionDebugInfo;
  addLog: (level: LogLevel, step: string, message: string, details?: unknown) => void;
  updateDebugInfo: (updates: Partial<ConversionDebugInfo>) => void;
  resetDebugInfo: () => void;
  setFileInfo: (name: string, size: number, mimeType: string) => void;
  clearLogs: () => void;
  startElapsedTimer: () => void;
  stopElapsedTimer: () => void;
}

const initialDebugInfo: ConversionDebugInfo = {
  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  fileName: null,
  fileSize: null,
  fileMimeType: null,
  ffmpegLoadStatus: 'idle',
  coreJsLoadStatus: 'idle',
  wasmLoadStatus: 'idle',
  mediaAnalysisStatus: 'idle',
  encoderValidationStatus: 'idle',
  encoderValidationResult: null,
  fileWriteStatus: 'idle',
  ffmpegExecStartTime: null,
  lastProgressValue: null,
  lastLogLines: [],
  errorCode: null,
  errorMessage: null,
  errorStack: null,
  elapsedTime: 0,
  logs: [],
};

export function useDebugLog(): UseDebugLogReturn {
  const [debugInfo, setDebugInfo] = useState<ConversionDebugInfo>(initialDebugInfo);
  const elapsedTimeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(Date.now());

  const clearElapsedTimer = useCallback(() => {
    if (elapsedTimeRef.current) {
      clearInterval(elapsedTimeRef.current);
      elapsedTimeRef.current = null;
    }
  }, []);

  const startElapsedTimer = useCallback(() => {
    clearElapsedTimer();
    startTimeRef.current = Date.now();
    elapsedTimeRef.current = setInterval(() => {
      setDebugInfo(prev => ({
        ...prev,
        elapsedTime: Math.floor((Date.now() - startTimeRef.current) / 1000),
      }));
    }, 1000);
  }, [clearElapsedTimer]);

  const stopElapsedTimer = useCallback(() => {
    clearElapsedTimer();
    setDebugInfo(prev => ({
      ...prev,
      elapsedTime: Math.floor((Date.now() - startTimeRef.current) / 1000),
    }));
  }, [clearElapsedTimer]);

  const addLog = useCallback((level: LogLevel, step: string, message: string, details?: unknown) => {
    const entry: DebugLogEntry = {
      timestamp: formatTimestamp(),
      level,
      step,
      message,
      details,
    };

    // Extract state updates from the log
    const stateUpdates = extractStateFromLog(step, message, level);

    setDebugInfo(prev => {
      const newLogs = [...prev.logs, entry];
      if (newLogs.length > MAX_LOG_ENTRIES) {
        newLogs.shift();
      }

      // Also update last log lines for quick reference
      let newLastLines = prev.lastLogLines;
      if (level === 'info' && (step === 'FFmpeg' || message.includes('[FFmpeg]'))) {
        newLastLines = [...prev.lastLogLines, `[${step}] ${message}`];
        if (newLastLines.length > MAX_LOG_LINES) {
          newLastLines.shift();
        }
      }

      return { 
        ...prev, 
        logs: newLogs,
        lastLogLines: newLastLines,
        ...stateUpdates,
      };
    });
  }, []);

  const updateDebugInfo = useCallback((updates: Partial<ConversionDebugInfo>) => {
    setDebugInfo(prev => ({ ...prev, ...updates }));
  }, []);

  const resetDebugInfo = useCallback(() => {
    clearElapsedTimer();
    setDebugInfo({
      ...initialDebugInfo,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      logs: [],
      lastLogLines: [],
    });
  }, [clearElapsedTimer]);

  const setFileInfo = useCallback((name: string, size: number, mimeType: string) => {
    updateDebugInfo({
      fileName: name,
      fileSize: size,
      fileMimeType: mimeType,
    });
  }, [updateDebugInfo]);

  const clearLogs = useCallback(() => {
    setDebugInfo(prev => ({ ...prev, logs: [], lastLogLines: [] }));
  }, []);

  return {
    debugInfo,
    addLog,
    updateDebugInfo,
    resetDebugInfo,
    setFileInfo,
    clearLogs,
    startElapsedTimer,
    stopElapsedTimer,
  };
}
