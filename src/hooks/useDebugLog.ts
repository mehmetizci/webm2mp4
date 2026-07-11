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
  const lowerMessage = message.toLowerCase();
  const updates: Partial<ConversionDebugInfo> = {};

  // Error handling - set all active states to error
  if (level === 'error') {
    if (lowerMessage.includes('ffmpeg')) {
      updates.ffmpegLoadStatus = 'error';
    }
    if (lowerMessage.includes('wasm')) {
      updates.wasmLoadStatus = 'error';
    }
    if (lowerMessage.includes('medya analizi') || lowerMessage.includes('media analysis')) {
      updates.mediaAnalysisStatus = 'error';
    }
    if (lowerMessage.includes('encoder') || lowerMessage.includes('doğrulama')) {
      updates.encoderValidationStatus = 'error';
    }
    if (lowerMessage.includes('write') || lowerMessage.includes('yazma') || lowerMessage.includes('dosya')) {
      updates.fileWriteStatus = 'error';
    }
    return Object.keys(updates).length > 0 ? updates : null;
  }

  // FFmpeg / WASM loading states
  if (step === 'FFmpeg' || step === 'CoreJS' || step === 'WASM') {
    if (lowerMessage.includes('yükleniyor') || lowerMessage.includes('loading') || lowerMessage.includes('başlatılıyor')) {
      if (step === 'CoreJS') updates.coreJsLoadStatus = 'loading';
      if (step === 'WASM') updates.wasmLoadStatus = 'loading';
      if (step === 'FFmpeg') updates.ffmpegLoadStatus = 'loading';
    }
    if (lowerMessage.includes('yüklendi') || lowerMessage.includes('loaded') || lowerMessage.includes('tamamlandı') || lowerMessage.includes('success')) {
      if (step === 'CoreJS') updates.coreJsLoadStatus = 'loaded';
      if (step === 'WASM') updates.wasmLoadStatus = 'loaded';
      if (step === 'FFmpeg') updates.ffmpegLoadStatus = 'loaded';
    }
  }

  // Media analysis states
  if (step === 'Media') {
    if (lowerMessage.includes('başlatılıyor') || lowerMessage.includes('starting') || lowerMessage.includes('analyzing')) {
      updates.mediaAnalysisStatus = 'analyzing';
    }
    if (lowerMessage.includes('tamamlandı') || lowerMessage.includes('completed')) {
      updates.mediaAnalysisStatus = 'completed';
    }
    if (lowerMessage.includes('hata') || lowerMessage.includes('error') || lowerMessage.includes('failed')) {
      updates.mediaAnalysisStatus = 'error';
    }
  }

  // Encoder validation states
  if (step === 'Encoder' || lowerMessage.includes('encoder')) {
    if (lowerMessage.includes('doğrulama') || lowerMessage.includes('validation') || lowerMessage.includes('validating')) {
      updates.encoderValidationStatus = 'validating';
    }
    if (lowerMessage.includes('tamamlandı') || lowerMessage.includes('completed') || lowerMessage.includes('success')) {
      updates.encoderValidationStatus = 'completed';
    }
    if (lowerMessage.includes('hata') || lowerMessage.includes('error') || lowerMessage.includes('failed')) {
      updates.encoderValidationStatus = 'error';
    }
  }

  // File write states
  if (lowerMessage.includes('write_file') || lowerMessage.includes('yazma') || step === 'File') {
    if (lowerMessage.includes('yazılıyor') || lowerMessage.includes('writing') || lowerMessage.includes('starting')) {
      updates.fileWriteStatus = 'writing';
    }
    if (lowerMessage.includes('yazıldı') || lowerMessage.includes('written') || lowerMessage.includes('success')) {
      updates.fileWriteStatus = 'written';
    }
    if (lowerMessage.includes('hata') || lowerMessage.includes('error') || lowerMessage.includes('failed')) {
      updates.fileWriteStatus = 'error';
    }
  }

  // General state updates from message content
  // Core JS
  if (lowerMessage.includes('core') && lowerMessage.includes('js')) {
    if (lowerMessage.includes('yükleniyor') || lowerMessage.includes('loading')) {
      updates.coreJsLoadStatus = 'loading';
    }
    if (lowerMessage.includes('yüklendi') || lowerMessage.includes('loaded') || lowerMessage.includes('tamamlandı')) {
      updates.coreJsLoadStatus = 'loaded';
    }
  }

  // WASM
  if (lowerMessage.includes('wasm')) {
    if (lowerMessage.includes('yükleniyor') || lowerMessage.includes('loading')) {
      updates.wasmLoadStatus = 'loading';
    }
    if (lowerMessage.includes('yüklendi') || lowerMessage.includes('loaded') || lowerMessage.includes('tamamlandı')) {
      updates.wasmLoadStatus = 'loaded';
    }
  }

  return Object.keys(updates).length > 0 ? updates : null;
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
