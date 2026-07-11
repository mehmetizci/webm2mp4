'use client';

import { useCallback, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { 
  ConversionProgress, 
  ConversionResult, 
  ConversionError,
  QualityPreset,
  ConversionStage,
} from '@/types/converter';
import { getOutputFileName } from '@/lib/file-utils';

const INPUT_FILE = 'input.webm';
const OUTPUT_FILE = 'output.mp4';

// Timeout values
const STALL_TIMEOUT_MS = 90000; // 90 seconds stall detection - activity-based
const MAX_EXECUTION_TIME_MS = 30 * 60 * 1000; // 30 minutes absolute safety limit
const DUPLICATE_FRAME_WARNING_THRESHOLD = 100;
const DUPLICATE_FRAME_ABORT_THRESHOLD = 1000;

interface FFmpegLogStats {
  encodedFrame: number | null;
  encodedTime: number | null;
  encodingFps: number | null;
  duplicatedFrames: number | null;
  encodingSpeed: number | null;
}

interface DebugCallbacks {
  addLog?: (level: 'info' | 'success' | 'warning' | 'error', step: string, message: string, details?: unknown) => void;
  updateDebugInfo?: (updates: Record<string, unknown>) => void;
}

interface UseFfmpegReturn {
  isLoaded: boolean;
  isLoading: boolean;
  progress: ConversionProgress;
  error: ConversionError | null;
  loadFFmpeg: () => Promise<boolean>;
  convert: (
    file: File,
    quality: QualityPreset,
    onStageChange?: (stage: ConversionStage) => void,
    videoDuration?: number | null
  ) => Promise<ConversionResult>;
  terminate: () => void;
}

// Check if device is mobile
function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// Get device memory (in GB)
function getDeviceMemory(): number | null {
  if (typeof navigator !== 'undefined' && 'deviceMemory' in navigator) {
    return (navigator as { deviceMemory?: number }).deviceMemory || null;
  }
  return null;
}

// Get CPU cores
function getCPUCores(): number {
  if (typeof navigator !== 'undefined' && 'hardwareConcurrency' in navigator) {
    return navigator.hardwareConcurrency || 4;
  }
  return 4;
}

// Parse FFmpeg progress line
function parseFFmpegProgress(line: string): FFmpegLogStats | null {
  const stats: FFmpegLogStats = {
    encodedFrame: null,
    encodedTime: null,
    encodingFps: null,
    duplicatedFrames: null,
    encodingSpeed: null,
  };

  const frameMatch = line.match(/frame=\s*(\d+)/);
  if (frameMatch) stats.encodedFrame = parseInt(frameMatch[1], 10);

  const timeMatch = line.match(/time=\s*(\d{2}):(\d{2}):(\d{2}\.?\d*)/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseFloat(timeMatch[3]);
    stats.encodedTime = hours * 3600 + minutes * 60 + seconds;
  }

  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  if (fpsMatch) stats.encodingFps = parseFloat(fpsMatch[1]);

  const dupMatch = line.match(/dup=\s*(\d+)/);
  if (dupMatch) stats.duplicatedFrames = parseInt(dupMatch[1], 10);

  const speedMatch = line.match(/speed=\s*([\d.]+)x/);
  if (speedMatch) stats.encodingSpeed = parseFloat(speedMatch[1]);

  if (stats.encodedFrame === null && stats.encodedTime === null) {
    return null;
  }

  return stats;
}

export function useFfmpeg(debugCallbacks?: DebugCallbacks): UseFfmpegReturn {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fileDataRef = useRef<Uint8Array | null>(null);
  const logHandlerRef = useRef<((data: { message: string }) => void) | null>(null);
  const progressHandlerRef = useRef<((data: { progress: number }) => void) | null>(null);
  const stallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const lastFFmpegMessageRef = useRef<string>('');
  const lastEncodedTimeRef = useRef<number | null>(null);
  const videoDurationRef = useRef<number | null>(null);
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ConversionProgress>({
    percent: 0,
    time: 0,
    stage: 'idle',
    hasProgress: false,
    encodedTime: null,
    encodingSpeed: null,
  });
  const [error, setError] = useState<ConversionError | null>(null);

  const startTimeRef = useRef<number>(Date.now());

  const { addLog, updateDebugInfo } = debugCallbacks || {};

  const normalizeError = (err: unknown): { message: string; stack: string | null } => {
    if (err instanceof Error) {
      return { message: err.message, stack: err.stack || null };
    }
    return { message: String(err), stack: null };
  };

  const clearAllTimeouts = useCallback(() => {
    if (stallTimeoutRef.current) {
      clearTimeout(stallTimeoutRef.current);
      stallTimeoutRef.current = null;
    }
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
    }
  }, []);

  const updateProgress = useCallback((
    percent: number, 
    stage: ConversionStage, 
    hasProgress = true,
    encodedTime?: number | null,
    encodingSpeed?: number | null
  ) => {
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    setProgress(prev => ({
      percent: Math.min(Math.max(percent, 0), 100),
      time: elapsed,
      stage,
      hasProgress,
      encodedTime: encodedTime !== undefined ? encodedTime : prev.encodedTime,
      encodingSpeed: encodingSpeed !== undefined ? encodingSpeed : prev.encodingSpeed,
    }));
  }, []);

  const cleanupFFmpegFiles = useCallback(async (ffmpeg: FFmpeg, fileName: string) => {
    try {
      await ffmpeg.deleteFile(fileName);
    } catch {
      // ignore
    }
  }, []);

  const cleanupAllFiles = useCallback(async (ffmpeg: FFmpeg) => {
    await cleanupFFmpegFiles(ffmpeg, INPUT_FILE);
    await cleanupFFmpegFiles(ffmpeg, OUTPUT_FILE);
  }, [cleanupFFmpegFiles]);

  const loadFFmpeg = useCallback(async (): Promise<boolean> => {
    if (ffmpegRef.current) {
      addLog?.('info', 'Load', 'FFmpeg zaten yüklü');
      return true;
    }
    
    if (isLoading) {
      addLog?.('info', 'Load', 'FFmpeg zaten yükleniyor...');
      while (isLoading) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return ffmpegRef.current !== null;
    }

    setIsLoading(true);
    setError(null);
    updateProgress(0, 'loading', false);
    updateDebugInfo?.({ ffmpegLoadStatus: 'loading' });

    const loadTimeout = setTimeout(() => {
      addLog?.('warning', 'Load', 'FFmpeg yükleme 10 saniyeyi aştı');
    }, 10000);

    try {
      const ffmpeg = new FFmpeg();
      addLog?.('info', 'Load', 'FFmpeg başlatılıyor');

      const loadLogHandler = ({ message }: { message: string }) => {
        console.log('[FFmpeg]', message);
      };
      ffmpeg.on('log', loadLogHandler);
      logHandlerRef.current = loadLogHandler;

      updateDebugInfo?.({ coreJsLoadStatus: 'loading', wasmLoadStatus: 'loading' });
      addLog?.('info', 'Load', 'Core JS yükleniyor');
      
      await ffmpeg.load({
        coreURL: '/ffmpeg/ffmpeg-core.js',
        wasmURL: '/ffmpeg/ffmpeg-core.wasm',
      });
      
      updateDebugInfo?.({ coreJsLoadStatus: 'loaded', wasmLoadStatus: 'loaded', ffmpegLoadStatus: 'loaded' });
      addLog?.('success', 'Load', 'Core JS yüklendi');
      addLog?.('success', 'Load', 'WASM yüklendi');

      ffmpegRef.current = ffmpeg;
      setIsLoaded(true);
      updateProgress(0, 'idle', false);
      addLog?.('success', 'Load', 'FFmpeg hazır');
      return true;
    } catch (err) {
      const { message, stack } = normalizeError(err);
      
      addLog?.('error', 'Load', `LOAD_FAILED: ${message}`);
      updateDebugInfo?.({ 
        ffmpegLoadStatus: 'error',
        errorCode: 'FFMPEG_LOAD_ERROR',
        errorMessage: message,
        errorStack: stack,
      });
      
      let errorMessage = 'Dönüştürücü yüklenemedi.';
      let errorCode = 'FFMPEG_LOAD_ERROR';
      
      if (message.includes('fetch') || message.includes('network') || message.includes('Failed to') || message.includes('404')) {
        errorMessage = 'FFmpeg dosyaları yüklenemedi. Lütfen internet bağlantınızı kontrol edin.';
        errorCode = 'FFMPEG_FETCH_ERROR';
      } else if (message.includes('WASM') || message.includes('wasm')) {
        errorMessage = 'WebAssembly yüklenemedi. Lütfen sayfayı yenileyin.';
        errorCode = 'WASM_LOAD_ERROR';
      }
      
      const errorObj: ConversionError = {
        code: errorCode,
        message: errorMessage,
        technical: `ffmpeg.load() başarısız\n${message}`,
      };
      setError(errorObj);
      updateProgress(0, 'error', false);
      return false;
    } finally {
      clearTimeout(loadTimeout);
      setIsLoading(false);
    }
  }, [isLoading, updateProgress, addLog, updateDebugInfo, normalizeError]);

  // Build FFmpeg arguments
  const buildFFmpegArgs = (crf: number, useFallback: boolean): string[] => {
    const mobile = isMobileDevice();
    const args: string[] = [
      '-fflags', '+genpts',
      '-i', INPUT_FILE,
      '-map', '0:v:0',
      '-map', '0:a?',
    ];

    if (useFallback) {
      args.push('-vf', 'setpts=N/(30*TB),fps=30', '-fps_mode', 'cfr');
      addLog?.('info', 'Convert', 'Fallback komut (setpts filtresi)');
    } else {
      args.push('-vf', 'fps=30', '-fps_mode', 'cfr');
    }

    args.push(
      '-c:v', 'libx264',
      '-preset', mobile ? 'ultrafast' : 'veryfast',
      '-crf', crf.toString(),
      '-pix_fmt', 'yuv420p',
      '-threads', '1',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-movflags', '+faststart',
      OUTPUT_FILE,
    );

    return args;
  };

  const convert = useCallback(async (
    file: File,
    quality: QualityPreset,
    onStageChange?: (stage: ConversionStage) => void,
    videoDuration?: number | null
  ): Promise<ConversionResult> => {
    // Store video duration for progress calculation
    videoDurationRef.current = videoDuration ?? null;
    if (videoDuration) {
      addLog?.('info', 'Convert', `Video süresi: ${videoDuration.toFixed(2)} sn`);
    }

    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      const err = new Error('FFmpeg henüz yüklenmedi');
      addLog?.('error', 'Convert', `HATA: FFmpeg mevcut değil`);
      const errorObj: ConversionError = {
        code: 'FFMPEG_NOT_LOADED',
        message: 'FFmpeg henüz yüklenmedi.',
        technical: `ffmpegRef.current is null`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    // Initialize
    startTimeRef.current = Date.now();
    clearAllTimeouts();
    setError(null);
    updateDebugInfo?.({ 
      fileWriteStatus: 'idle', 
      ffmpegExecStatus: 'idle',
      ffmpegExecStartTime: null, 
      lastProgressValue: null,
      errorCode: null,
      errorMessage: null,
    });

    const crfMap: Record<QualityPreset, number> = {
      high: 18,
      balanced: 23,
      small: 28,
    };
    const crf = crfMap[quality];

    const deviceMemory = getDeviceMemory();
    const cpuCores = getCPUCores();
    const mobile = isMobileDevice();
    addLog?.('info', 'Convert', `Cihaz: Hafıza=${deviceMemory || 'bilinmiyor'}GB, Çekirdek=${cpuCores}, Mobil=${mobile}`);
    addLog?.('info', 'Convert', `Dosya boyutu: ${(file.size / (1024 * 1024)).toFixed(2)}MB, CRF=${crf}`);

    // Step 1: Read file
    onStageChange?.('reading');
    updateProgress(0, 'reading', false);
    addLog?.('info', 'Convert', 'Dosya okunuyor...');
    
    let fileData: Uint8Array;
    try {
      fileData = new Uint8Array(await file.arrayBuffer());
      addLog?.('info', 'Convert', `Dosya belleğe yüklendi: ${fileData.byteLength} bytes`);
      updateDebugInfo?.({ fileSize: fileData.byteLength });
    } catch (err) {
      const { message, stack } = normalizeError(err);
      addLog?.('error', 'Convert', `FILE_READ_FAILED: ${message}`);
      const errorObj: ConversionError = {
        code: 'FILE_READ_ERROR',
        message: 'Video dosyası okunamadı.',
        technical: `file.arrayBuffer() başarısız\n${message}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    // Step 2: Write file to FFmpeg VFS
    addLog?.('info', 'Convert', `WRITE_FILE_STARTED`);
    updateDebugInfo?.({ fileWriteStatus: 'writing' });
    
    try {
      fileDataRef.current = fileData;
      await ffmpeg.writeFile(INPUT_FILE, fileData);
      updateDebugInfo?.({ fileWriteStatus: 'written' });
      addLog?.('success', 'Convert', `WRITE_FILE_SUCCESS`);
    } catch (err) {
      const { message, stack } = normalizeError(err);
      updateDebugInfo?.({ fileWriteStatus: 'error' });
      addLog?.('error', 'Convert', `WRITE_FILE_FAILED: ${message}`);
      const errorObj: ConversionError = {
        code: 'WRITE_FILE_ERROR',
        message: 'Dosya FFmpeg VFS\'ye yazılamadı.',
        technical: `ffmpeg.writeFile() başarısız\n${message}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }
  
    // Step 3: Execute FFmpeg
    onStageChange?.('converting');
    updateProgress(10, 'converting', false, null, null);
    addLog?.('info', 'Convert', 'EXEC_STARTED');
    updateDebugInfo?.({ ffmpegExecStatus: 'running', ffmpegExecStartTime: Date.now() });

    const ffmpegArgs = buildFFmpegArgs(crf, false);
    addLog?.('info', 'FFmpeg', `Komut: ${ffmpegArgs.join(' ')}`);

    let maxDuplicatedFrames = 0;
    let hasWarnedAboutDuplicates = false;
    let hasRetriedWithFallback = false;
    let lastProgressPercent = 10;

    // Calculate progress percentage based on encoded time and video duration
    const calculateProgressPercent = (encodedTime: number | null): number => {
      if (encodedTime === null || videoDurationRef.current === null || videoDurationRef.current <= 0) {
        return lastProgressPercent;
      }
      const duration = videoDurationRef.current;
      // Formula: start at 10%, end at 95%, scale encoded time to duration ratio
      const ratio = Math.min(encodedTime / duration, 1);
      return Math.min(95, Math.max(10, 10 + ratio * 85));
    };

    // Progress handler
    progressHandlerRef.current = (data: { progress: number; time?: number }) => {
      lastActivityRef.current = Date.now();
      const normalizedProgress = data.progress;
      if (normalizedProgress > 0 && normalizedProgress <= 1) {
        lastProgressPercent = calculateProgressPercent(null);
        updateProgress(lastProgressPercent, 'converting', true, null, null);
        updateDebugInfo?.({ lastProgressValue: lastProgressPercent });
      }
    };
    ffmpeg.on('progress', progressHandlerRef.current);

    // FFmpeg log handler
    const ffmpegLogHandler = ({ message }: { message: string }) => {
      lastActivityRef.current = Date.now();
      
      if (message === lastFFmpegMessageRef.current) return;
      lastFFmpegMessageRef.current = message;
      
      const stats = parseFFmpegProgress(message);
      if (stats) {
        // Update last encoded time reference
        if (stats.encodedTime !== null) {
          lastEncodedTimeRef.current = stats.encodedTime;
        }

        updateDebugInfo?.({
          encodedFrame: stats.encodedFrame,
          encodedTime: stats.encodedTime,
          encodingFps: stats.encodingFps,
          duplicatedFrames: stats.duplicatedFrames,
          encodingSpeed: stats.encodingSpeed,
        });

        if (stats.duplicatedFrames !== null) {
          if (stats.duplicatedFrames > maxDuplicatedFrames) {
            maxDuplicatedFrames = stats.duplicatedFrames;
          }
          if (stats.duplicatedFrames > DUPLICATE_FRAME_WARNING_THRESHOLD && !hasWarnedAboutDuplicates) {
            hasWarnedAboutDuplicates = true;
            addLog?.('warning', 'Convert', `Timestamp problemi: ${stats.duplicatedFrames} duplicate frame`);
          }
        }

        // Update progress based on encoded time if we have video duration
        if (stats.encodedTime !== null) {
          lastProgressPercent = calculateProgressPercent(stats.encodedTime);
          updateProgress(lastProgressPercent, 'converting', true, stats.encodedTime, stats.encodingSpeed);
          updateDebugInfo?.({ lastProgressValue: lastProgressPercent });
        } else if (stats.encodedFrame !== null && stats.encodedFrame > 0) {
          // Fallback: animate progress for unknown duration
          updateProgress(lastProgressPercent, 'converting', true, null, stats.encodingSpeed);
        }
      }

      addLog?.('info', 'FFmpeg', message);
    };
    ffmpeg.on('log', ffmpegLogHandler);

    // Reset activity timer for execution
    lastActivityRef.current = Date.now();
    lastEncodedTimeRef.current = null;

    // Stall timeout - check every 10 seconds
    let stallCheckInterval: ReturnType<typeof setInterval> | null = null;
    stallCheckInterval = setInterval(() => {
      const timeSinceLastActivity = Date.now() - lastActivityRef.current;
      if (timeSinceLastActivity >= STALL_TIMEOUT_MS) {
        if (stallCheckInterval) {
          clearInterval(stallCheckInterval);
        }
        addLog?.('error', 'Convert', `STALL_DETECTED: 90 saniye aktivite yok`);
        updateDebugInfo?.({ ffmpegExecStatus: 'timeout' });
        
        ffmpeg.terminate();
        
        clearAllTimeouts();
        if (progressHandlerRef.current) {
          ffmpeg.off('progress', progressHandlerRef.current);
          progressHandlerRef.current = null;
        }
        ffmpeg.off('log', ffmpegLogHandler);
        
        const errorObj: ConversionError = {
          code: 'EXEC_STALLED',
          message: 'Video dönüştürme işlemi yavaşladı veya durdu.',
          technical: `90 saniye boyunca FFmpeg aktivitesi yok (frame=${lastEncodedTimeRef.current !== null ? 'encoded' : 'unknown'})`,
        };
        setError(errorObj);
        updateDebugInfo?.({ errorCode: 'EXEC_STALLED', errorMessage: errorObj.message });
        onStageChange?.('error');
        throw new Error('EXEC_STALLED');
      }
    }, 10000); // Check every 10 seconds

    // Safety timeout - 30 minutes absolute limit
    safetyTimeoutRef.current = setTimeout(() => {
      if (stallCheckInterval) {
        clearInterval(stallCheckInterval);
        stallCheckInterval = null;
      }
      addLog?.('error', 'Convert', `SAFETY_TIMEOUT: 30 dakika aşıldı`);
      updateDebugInfo?.({ ffmpegExecStatus: 'timeout' });
      
      ffmpeg.terminate();
      
      clearAllTimeouts();
      if (progressHandlerRef.current) {
        ffmpeg.off('progress', progressHandlerRef.current);
        progressHandlerRef.current = null;
      }
      ffmpeg.off('log', ffmpegLogHandler);
      
      const errorObj: ConversionError = {
        code: 'EXEC_SAFETY_TIMEOUT',
        message: 'Video dönüştürme işlemi çok uzun sürdü.',
        technical: `30 dakika güvenlik limiti aşıldı`,
      };
      setError(errorObj);
      updateDebugInfo?.({ errorCode: 'EXEC_SAFETY_TIMEOUT', errorMessage: errorObj.message });
      onStageChange?.('error');
      throw new Error('EXEC_SAFETY_TIMEOUT');
    }, MAX_EXECUTION_TIME_MS);

    let execSuccess = false;
    let execError: Error | null = null;

    try {
      await ffmpeg.exec(ffmpegArgs);
      execSuccess = true;
      addLog?.('success', 'Convert', 'EXEC_SUCCESS');
      updateDebugInfo?.({ ffmpegExecStatus: 'completed' });
    } catch (err) {
      const { message } = normalizeError(err);
      execError = err instanceof Error ? err : new Error(message);
      
      // Check if it's a stall or safety timeout (already handled)
      if (message === 'EXEC_STALLED' || message === 'EXEC_SAFETY_TIMEOUT') {
        throw execError;
      }
      
      // Retry with fallback if duplicate frames are high
      if (!hasRetriedWithFallback && maxDuplicatedFrames > DUPLICATE_FRAME_ABORT_THRESHOLD) {
        hasRetriedWithFallback = true;
        addLog?.('warning', 'Convert', `Fallback: ${maxDuplicatedFrames} duplicate frame`);
        
        if (progressHandlerRef.current) {
          ffmpeg.off('progress', progressHandlerRef.current);
          progressHandlerRef.current = null;
        }
        ffmpeg.off('log', ffmpegLogHandler);
        
        // Reset activity timer
        lastActivityRef.current = Date.now();
        lastEncodedTimeRef.current = null;
        maxDuplicatedFrames = 0;
        hasWarnedAboutDuplicates = false;
        lastProgressPercent = 10;
        lastFFmpegMessageRef.current = '';
        
        const fallbackArgs = buildFFmpegArgs(crf, true);
        addLog?.('info', 'FFmpeg', `Fallback Komut: ${fallbackArgs.join(' ')}`);
        
        progressHandlerRef.current = (data: { progress: number }) => {
          lastActivityRef.current = Date.now();
          const normalizedProgress = data.progress;
          if (normalizedProgress > 0 && normalizedProgress <= 1) {
            lastProgressPercent = calculateProgressPercent(null);
            updateProgress(lastProgressPercent, 'converting', true);
            updateDebugInfo?.({ lastProgressValue: lastProgressPercent });
          }
        };
        ffmpeg.on('progress', progressHandlerRef.current);
        
        const retryLogHandler = ({ message }: { message: string }) => {
          lastActivityRef.current = Date.now();
          if (message === lastFFmpegMessageRef.current) return;
          lastFFmpegMessageRef.current = message;
          
          const stats = parseFFmpegProgress(message);
          if (stats) {
            if (stats.encodedTime !== null) {
              lastEncodedTimeRef.current = stats.encodedTime;
            }
            updateDebugInfo?.({
              encodedFrame: stats.encodedFrame,
              encodedTime: stats.encodedTime,
              encodingFps: stats.encodingFps,
              duplicatedFrames: stats.duplicatedFrames,
              encodingSpeed: stats.encodingSpeed,
            });
            if (stats.duplicatedFrames !== null && stats.duplicatedFrames > maxDuplicatedFrames) {
              maxDuplicatedFrames = stats.duplicatedFrames;
            }
            if (stats.encodedTime !== null) {
              lastProgressPercent = calculateProgressPercent(stats.encodedTime);
              updateProgress(lastProgressPercent, 'converting', true, stats.encodedTime, stats.encodingSpeed);
            }
          }
          addLog?.('info', 'FFmpeg', message);
        };
        ffmpeg.on('log', retryLogHandler);
        
        try {
          await ffmpeg.exec(fallbackArgs);
          execSuccess = true;
          addLog?.('success', 'Convert', 'EXEC_SUCCESS (Fallback)');
          updateDebugInfo?.({ ffmpegExecStatus: 'completed' });
        } catch (retryErr) {
          const { message: retryMsg } = normalizeError(retryErr);
          execError = retryErr instanceof Error ? retryErr : new Error(retryMsg);
          if (progressHandlerRef.current) {
            ffmpeg.off('progress', progressHandlerRef.current);
            progressHandlerRef.current = null;
          }
          ffmpeg.off('log', retryLogHandler);
        }
      }
    }
    
    // Clean up timeouts and handlers
    if (stallCheckInterval) {
      clearInterval(stallCheckInterval);
    }
    clearAllTimeouts();
    if (progressHandlerRef.current) {
      ffmpeg.off('progress', progressHandlerRef.current);
      progressHandlerRef.current = null;
    }
    ffmpeg.off('log', ffmpegLogHandler);

    if (!execSuccess && execError) {
      // Only set ffmpegExecStatus to error, NOT ffmpegLoadStatus
      // FFmpeg may still be loaded even if execution fails
      updateDebugInfo?.({ ffmpegExecStatus: 'error' });
      
      const errorObj: ConversionError = {
        code: 'CONVERSION_ERROR',
        message: 'Video dönüştürülürken bir hata oluştu.',
        technical: `ffmpeg.exec() başarısız\nHata: ${execError.message}`,
      };
      setError(errorObj);
      updateDebugInfo?.({ errorCode: 'CONVERSION_ERROR', errorMessage: errorObj.message });
      onStageChange?.('error');
      throw execError;
    }

    // Step 4: Read output
    onStageChange?.('finalizing');
    updateProgress(95, 'finalizing', true);
    addLog?.('info', 'Convert', 'MP4 okunuyor...');
    
    let outputData: Uint8Array | string;
    try {
      const rawOutput = await ffmpeg.readFile(OUTPUT_FILE);
      if (rawOutput instanceof Uint8Array) {
        outputData = rawOutput;
      } else if (typeof rawOutput === 'string') {
        outputData = rawOutput;
      } else {
        outputData = new Uint8Array(rawOutput as ArrayBuffer);
      }
      addLog?.('success', 'Convert', `OUTPUT_READ_SUCCESS: ${outputData instanceof Uint8Array ? outputData.byteLength : 'bilinmiyor'} bytes`);
    } catch (err) {
      const { message, stack } = normalizeError(err);
      addLog?.('error', 'Convert', `OUTPUT_READ_FAILED: ${message}`);
      const errorObj: ConversionError = {
        code: 'OUTPUT_READ_ERROR',
        message: 'MP4 dosyası okunamadı.',
        technical: `ffmpeg.readFile() başarısız\n${message}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    onStageChange?.('complete');
    updateProgress(100, 'complete', true);
    updateDebugInfo?.({ ffmpegExecStatus: 'completed', fileWriteStatus: 'written' });

    let uint8Output: Uint8Array;
    if (outputData instanceof Uint8Array) {
      uint8Output = new Uint8Array(outputData);
    } else if (typeof outputData === 'string') {
      const encoder = new TextEncoder();
      uint8Output = encoder.encode(outputData);
    } else {
      uint8Output = new Uint8Array(outputData as ArrayBuffer);
    }
    
    const blob = new Blob([uint8Output.buffer as ArrayBuffer], { type: 'video/mp4' });
    const duration = (Date.now() - startTimeRef.current) / 1000;
    
    addLog?.('success', 'Convert', `CONVERSION_COMPLETE: ${duration.toFixed(1)} sn, ${blob.size} bytes`);

    if (progressHandlerRef.current && ffmpeg) {
      ffmpeg.off('progress', progressHandlerRef.current);
      progressHandlerRef.current = null;
    }
    
    await cleanupAllFiles(ffmpeg);
    
    if (fileDataRef.current) {
      fileDataRef.current = null;
    }

    return {
      blob,
      fileName: getOutputFileName(file.name),
      fileSize: blob.size,
      duration,
    };
  }, [updateProgress, clearAllTimeouts, addLog, updateDebugInfo, normalizeError]);

  const terminate = useCallback(() => {
    clearAllTimeouts();
    if (ffmpegRef.current) {
      if (logHandlerRef.current) {
        ffmpegRef.current.off('log', logHandlerRef.current);
        logHandlerRef.current = null;
      }
      if (progressHandlerRef.current) {
        ffmpegRef.current.off('progress', progressHandlerRef.current);
        progressHandlerRef.current = null;
      }
      
      ffmpegRef.current.terminate();
      ffmpegRef.current = null;
      setIsLoaded(false);
    }
    if (fileDataRef.current) {
      fileDataRef.current = null;
    }
    setProgress({ percent: 0, time: 0, stage: 'idle', hasProgress: false });
    setError(null);
    updateDebugInfo?.({ ffmpegExecStatus: 'idle', fileWriteStatus: 'idle' });
  }, [clearAllTimeouts, updateDebugInfo]);

  return {
    isLoaded,
    isLoading,
    progress,
    error,
    loadFFmpeg,
    convert,
    terminate,
  };
}
