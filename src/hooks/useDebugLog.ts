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
  // Conversion engine selection
  selectedEngine: 'webcodecs' | 'ffmpeg-wasm' | null;
  actualEngineUsed: 'webcodecs' | 'ffmpeg-wasm' | null;
  // WebCodecs detailed capabilities
  webCodecsSecureContext: boolean | null;
  webCodecsVideoEncoder: boolean | null;
  webCodecsVideoDecoder: boolean | null;
  webCodecsVideoFrame: boolean | null;
  webCodecsMediaRecorder: boolean | null;
  webCodecsSupported: boolean;
  webCodecsSupportReason: string | null;
  webCodecsFailureDetails: string | null;
  webCodecsH264Supported: boolean | null;
  webCodecsH264BaselineSupported: boolean | null;
  webCodecsTestedCodec: string | null;
  webCodecsHardwareAcceleration: string | null;
  webCodecsDetectionTimeMs: number | null;
  webCodecsTimedOut: boolean | null;
  webCodecsCodecResults: Array<{ codec: string; profile: string; supported: boolean | null }>;
  // FFmpeg load status
  ffmpegLoadStatus: 'idle' | 'loading' | 'loaded' | 'error';
  coreJsLoadStatus: 'idle' | 'loading' | 'loaded' | 'error';
  wasmLoadStatus: 'idle' | 'loading' | 'loaded' | 'error';
  mediaAnalysisStatus: 'idle' | 'analyzing' | 'completed' | 'error';
  encoderValidationStatus: 'idle' | 'validating' | 'completed' | 'error';
  encoderValidationResult: { h264: boolean; aac: boolean } | null;
  fileWriteStatus: 'idle' | 'writing' | 'written' | 'error';
  ffmpegExecStatus: 'idle' | 'running' | 'completed' | 'error' | 'timeout';
  ffmpegExecStartTime: number | null;
  lastProgressValue: number | null;
  // FFmpeg encoding stats
  encodedFrame: number | null;
  encodedTime: number | null;
  encodingFps: number | null;
  encodingSpeed: number | null;
  duplicatedFrames: number | null;
  // Total video duration
  totalDuration: number | null;
  // Metadata source (how duration was obtained)
  metadataSource: 'html5' | 'mediabunny' | 'ffmpeg_fallback' | null;
  // Output read status
  outputReadStatus: 'idle' | 'reading' | 'read' | 'error';
  // Compression stats
  inputSize: number | null;
  outputSize: number | null;
  compressionRatio: number | null;
  videoBitrate: number | null;
  audioBitrate: number | null;
  totalBitrate: number | null;
  // Encoding stats
  encodeTime: number | null;
  averageSpeed: number | null;
  // WebCodecs encoder config (from actual encoder settings)
  webCodecsEncoderConfig: {
    codec: string;
    targetBitrate: number;
    framerate: number;
    hardwareAcceleration: string;
    keyFrameInterval: number;
    forceTranscode: boolean;
    bitrateMode?: string;
    latencyMode?: string;
  } | null;
  webCodecsActualBitrate: number | null;
  webCodecsBitrateDifference: number | null;
  webCodecsOutputWidth: number | null;
  webCodecsOutputHeight: number | null;
  webCodecsQualityPreset: string | null;
  webCodecsHardwareMode: string | null;
  webCodecsIsValid: boolean | null;
  // Low-level converter specific
  webCodecsBitrateModeSupported: boolean | null;
  webCodecsBitrateModeRequested: string | null;
  webCodecsConversionId: string | null;
  webCodecsPipeline: 'Low Level' | 'Standard' | null;
  // Cleanup status
  cleanupStatus: 'idle' | 'cleaning' | 'completed' | 'warning' | 'error';
  cleanupValidation: {
    inputDeleted: boolean;
    outputDeleted: boolean;
    listenersRemoved: boolean;
    timersCleared: boolean;
    workerTerminated: boolean;
    errorDuringCleanup: string | null;
  } | null;
  cleanupDuration: number | null;
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

  // Error handling
  if (level === 'error') {
    if (step === 'FFmpeg' || step === 'Load' || step === 'Convert' || message.includes('FFmpeg')) {
      updates.ffmpegLoadStatus = 'error';
      updates.ffmpegExecStatus = 'error';
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
    if (step === 'Convert' || step === 'File') {
      if (message.includes('WRITE_FILE_FAILED')) {
        updates.fileWriteStatus = 'error';
      }
      if (message.includes('EXEC_FAILED') || message.includes('EXEC_ERROR')) {
        updates.ffmpegExecStatus = 'error';
      }
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
  // fileWriteStatus - only these exact markers
  if (step === 'Convert' || step === 'File') {
    if (message.includes('WRITE_FILE_STARTED')) {
      updates.fileWriteStatus = 'writing';
    }
    if (message.includes('WRITE_FILE_SUCCESS')) {
      updates.fileWriteStatus = 'written';
    }
    if (message.includes('WRITE_FILE_FAILED')) {
      updates.fileWriteStatus = 'error';
    }
    
    // ffmpegExecStatus
    if (message.includes('EXEC_STARTED')) {
      updates.ffmpegExecStatus = 'running';
    }
    if (message.includes('EXEC_SUCCESS') || message.includes('EXEC_COMPLETE') || message.includes('CONVERSION_COMPLETE')) {
      updates.ffmpegExecStatus = 'completed';
    }
    if (message.includes('EXEC_FAILED') || message.includes('EXEC_ERROR')) {
      updates.ffmpegExecStatus = 'error';
    }
    if (message.includes('EXEC_TIMEOUT') || message.includes('ZAMAN ASIMI') || message.includes('TIMEOUT')) {
      updates.ffmpegExecStatus = 'timeout';
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
  // Conversion engine selection
  selectedEngine: null,
  actualEngineUsed: null,
  // WebCodecs detailed capabilities
  webCodecsSecureContext: null,
  webCodecsVideoEncoder: null,
  webCodecsVideoDecoder: null,
  webCodecsVideoFrame: null,
  webCodecsMediaRecorder: null,
  webCodecsSupported: false,
  webCodecsSupportReason: null,
  webCodecsFailureDetails: null,
  webCodecsH264Supported: null,
  webCodecsH264BaselineSupported: null,
  webCodecsTestedCodec: null,
  webCodecsHardwareAcceleration: null,
  webCodecsDetectionTimeMs: null,
  webCodecsTimedOut: null,
  webCodecsCodecResults: [],
  // FFmpeg load status
  ffmpegLoadStatus: 'idle',
  coreJsLoadStatus: 'idle',
  wasmLoadStatus: 'idle',
  mediaAnalysisStatus: 'idle',
  encoderValidationStatus: 'idle',
  encoderValidationResult: null,
  fileWriteStatus: 'idle',
  ffmpegExecStatus: 'idle',
  ffmpegExecStartTime: null,
  lastProgressValue: null,
  // FFmpeg encoding stats
  encodedFrame: null,
  encodedTime: null,
  encodingFps: null,
  encodingSpeed: null,
  duplicatedFrames: null,
  // Total video duration
  totalDuration: null,
  // Metadata source
  metadataSource: null,
  // Output read status
  outputReadStatus: 'idle',
  // Compression stats
  inputSize: null,
  outputSize: null,
  compressionRatio: null,
  videoBitrate: null,
  audioBitrate: null,
  totalBitrate: null,
  // Encoding stats
  encodeTime: null,
  averageSpeed: null,
  // WebCodecs encoder config
  webCodecsEncoderConfig: null,
  webCodecsActualBitrate: null,
  webCodecsBitrateDifference: null,
  webCodecsOutputWidth: null,
  webCodecsOutputHeight: null,
  webCodecsQualityPreset: null,
  webCodecsHardwareMode: null,
  webCodecsIsValid: null,
  // Low-level converter specific
  webCodecsBitrateModeSupported: null,
  webCodecsBitrateModeRequested: null,
  webCodecsConversionId: null,
  webCodecsPipeline: null,
  // Cleanup status
  cleanupStatus: 'idle',
  cleanupValidation: null,
  cleanupDuration: null,
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

      // Also update last log lines for quick reference (FFmpeg raw logs)
      let newLastLines = prev.lastLogLines;
      if (step === 'FFmpeg') {
        newLastLines = [...prev.lastLogLines, message];
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
