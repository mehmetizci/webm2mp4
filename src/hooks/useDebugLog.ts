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

    setDebugInfo(prev => {
      const newLogs = [...prev.logs, entry];
      if (newLogs.length > MAX_LOG_ENTRIES) {
        newLogs.shift();
      }
      return { ...prev, logs: newLogs };
    });

    // Also update last log lines for quick reference
    if (level === 'info' && message.includes('[FFmpeg]')) {
      setDebugInfo(prev => {
        const newLastLines = [...prev.lastLogLines, message];
        if (newLastLines.length > MAX_LOG_LINES) {
          newLastLines.shift();
        }
        return { ...prev, lastLogLines: newLastLines };
      });
    }
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
