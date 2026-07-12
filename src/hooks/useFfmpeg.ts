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
    videoDuration?: number | null,
    sourceWidth?: number | null,
    sourceHeight?: number | null
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
  const maxEncodedTimeRef = useRef<number>(0); // Track max encoded time for FFmpeg fallback
  const hasHtml5MetadataRef = useRef(false); // Track if HTML5 metadata was successful
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ConversionProgress>({
    percent: 0,
    time: 0,
    stage: 'idle',
    hasProgress: false,
    encodedTime: null,
    encodingSpeed: null,
    totalDuration: null,
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
    encodingSpeed?: number | null,
    totalDuration?: number | null
  ) => {
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    setProgress(prev => ({
      percent: Math.min(Math.max(percent, 0), 100),
      time: elapsed,
      stage,
      hasProgress,
      encodedTime: encodedTime !== undefined ? encodedTime : prev.encodedTime,
      encodingSpeed: encodingSpeed !== undefined ? encodingSpeed : prev.encodingSpeed,
      totalDuration: totalDuration !== undefined ? totalDuration : prev.totalDuration,
    }));
  }, []);

  // Reentrant protection - prevents double cleanup
  const cleanupInProgressRef = useRef(false);
  
  // Cleanup validation results
  interface CleanupValidation {
    inputDeleted: boolean;
    outputDeleted: boolean;
    listenersRemoved: boolean;
    timersCleared: boolean;
    workerTerminated: boolean;
    errorDuringCleanup: string | null;
  }

  // Unified cleanup function - handles all cleanup in proper order
  const cleanupResources = useCallback(async (options: {
    terminateWorker: boolean;
    reason?: string;
  }): Promise<CleanupValidation> => {
    const { terminateWorker, reason = 'Unknown' } = options;
    
    // Reentrant protection - prevent double cleanup
    if (cleanupInProgressRef.current) {
      addLog?.('info', 'Cleanup', 'Cleanup already in progress, skipping');
      return {
        inputDeleted: false,
        outputDeleted: false,
        listenersRemoved: false,
        timersCleared: false,
        workerTerminated: false,
        errorDuringCleanup: 'cleanup_in_progress',
      };
    }
    
    cleanupInProgressRef.current = true;
    const cleanupStartTime = Date.now();
    
    const validation: CleanupValidation = {
      inputDeleted: false,
      outputDeleted: false,
      listenersRemoved: false,
      timersCleared: false,
      workerTerminated: false,
      errorDuringCleanup: null,
    };
    
    updateDebugInfo?.({ cleanupStatus: 'cleaning' });
    addLog?.('info', 'Cleanup', `Starting cleanup: terminateWorker=${terminateWorker}, reason=${reason}`);
    
    try {
      const ffmpeg = ffmpegRef.current;
      
      // Step 1: Clean VFS files FIRST (before terminate)
      // Files must be deleted before worker is terminated
      if (ffmpeg) {
        try {
          await ffmpeg.deleteFile(INPUT_FILE);
          validation.inputDeleted = true;
          addLog?.('info', 'Cleanup', 'Input file deleted');
        } catch {
          // File might not exist - this is OK
          validation.inputDeleted = true; // Consider it cleaned
        }
        
        try {
          await ffmpeg.deleteFile(OUTPUT_FILE);
          validation.outputDeleted = true;
          addLog?.('info', 'Cleanup', 'Output file deleted');
        } catch {
          // File might not exist - this is OK
          validation.outputDeleted = true; // Consider it cleaned
        }
      }
      
      // Step 2: Remove all listeners
      try {
        if (logHandlerRef.current && ffmpeg) {
          ffmpeg.off('log', logHandlerRef.current);
        }
        if (progressHandlerRef.current && ffmpeg) {
          ffmpeg.off('progress', progressHandlerRef.current);
        }
        logHandlerRef.current = null;
        progressHandlerRef.current = null;
        validation.listenersRemoved = true;
        addLog?.('info', 'Cleanup', 'Listeners removed');
      } catch (e) {
        addLog?.('warning', 'Cleanup', `Listener removal error: ${e}`);
      }
      
      // Step 3: Clear all timers
      try {
        clearAllTimeouts();
        validation.timersCleared = true;
        addLog?.('info', 'Cleanup', 'Timers cleared');
      } catch (e) {
        addLog?.('warning', 'Cleanup', `Timer clearing error: ${e}`);
      }
      
      // Step 4: Terminate worker if needed (LAST step)
      if (terminateWorker && ffmpeg) {
        try {
          ffmpeg.terminate();
          validation.workerTerminated = true;
          addLog?.('info', 'Cleanup', 'Worker terminated');
        } catch (e) {
          addLog?.('warning', 'Cleanup', `Worker terminate error: ${e}`);
        }
        
        // Reset all state after terminate
        ffmpegRef.current = null;
        setIsLoaded(false);
        setProgress({
          percent: 0,
          time: 0,
          stage: 'idle',
          hasProgress: false,
          encodedTime: null,
          encodingSpeed: null,
        });
        updateDebugInfo?.({
          ffmpegExecStatus: 'error',
          ffmpegLoadStatus: 'idle',
        });
      }
      
      // Clear file data reference
      fileDataRef.current = null;
      
      // Calculate cleanup duration
      const cleanupDuration = Date.now() - cleanupStartTime;
      
      // Update debug info with validation results
      updateDebugInfo?.({
        cleanupStatus: 'completed',
        cleanupValidation: validation,
        cleanupDuration,
      });
      
      addLog?.('info', 'Cleanup', `Cleanup completed in ${cleanupDuration}ms`);
      addLog?.('info', 'Cleanup', `Validation: input=${validation.inputDeleted}, output=${validation.outputDeleted}, listeners=${validation.listenersRemoved}, timers=${validation.timersCleared}, terminated=${validation.workerTerminated}`);
      
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      validation.errorDuringCleanup = errorMessage;
      addLog?.('warning', 'Cleanup', `Cleanup error: ${errorMessage}`);
      updateDebugInfo?.({
        cleanupStatus: 'warning',
        cleanupValidation: validation,
      });
    } finally {
      cleanupInProgressRef.current = false;
    }
    
    return validation;
  }, [clearAllTimeouts, updateDebugInfo, addLog]);

  // Pre-cleanup: Remove leftover files before new conversion
  const preCleanup = useCallback(async () => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) return;
    
    addLog?.('info', 'Cleanup', 'Pre-cleanup: checking for leftover files');
    try {
      await ffmpeg.deleteFile(INPUT_FILE);
      addLog?.('info', 'Cleanup', 'Leftover input file removed');
    } catch {
      // File might not exist
    }
    try {
      await ffmpeg.deleteFile(OUTPUT_FILE);
      addLog?.('info', 'Cleanup', 'Leftover output file removed');
    } catch {
      // File might not exist
    }
  }, [addLog]);

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

  // Calculate maxrate based on source resolution and quality preset
  const getMaxRateForResolution = (width: number | null, presetMaxRate: number): number => {
    if (!width) return presetMaxRate; // Default to preset maxrate
    if (width <= 480) return 400; // 480p or smaller - cap at 400k
    if (width <= 720) return presetMaxRate; // 720p - use preset
    return presetMaxRate; // 1080p+ - will be scaled to 720p, use preset
  };

  // Get scale filter for resolution
  const getScaleFilter = (sourceWidth: number | null): string | null => {
    if (!sourceWidth) return null;
    if (sourceWidth <= 720) return null; // No scaling needed
    return 'scale=720:-2'; // Scale to 720px width, maintain aspect ratio
  };

  // Build FFmpeg arguments
  const buildFFmpegArgs = (
    crf: number,
    maxRate: number,
    useFallback: boolean, 
    sourceWidth: number | null,
    sourceHeight: number | null
  ): string[] => {
    const mobile = isMobileDevice();
    const effectiveMaxRate = getMaxRateForResolution(sourceWidth, maxRate);
    const bufSize = Math.ceil(effectiveMaxRate * 2); // bufsize = 2x maxrate
    const scaleFilter = getScaleFilter(sourceWidth);

    const args: string[] = [
      '-fflags', '+genpts',
      '-i', INPUT_FILE,
      '-map', '0:v:0',
      '-map', '0:a?',
    ];

    // Build video filter
    const videoFilters: string[] = [];
    if (scaleFilter) {
      videoFilters.push(scaleFilter);
    }
    if (useFallback) {
      videoFilters.push('setpts=N/(30*TB)');
    }
    videoFilters.push('fps=30');

    if (videoFilters.length > 0) {
      args.push('-vf', videoFilters.join(','), '-fps_mode', 'cfr');
      if (useFallback) {
        addLog?.('info', 'Convert', `Fallback komut (setpts filtresi)`);
      }
    }

    // Video encoding with constrained bitrate
    args.push(
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-level:v', '3.1',
      '-preset', mobile ? 'ultrafast' : 'veryfast',
      '-crf', crf.toString(),
      '-maxrate', `${effectiveMaxRate}k`,
      '-bufsize', `${bufSize}k`,
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-threads', '1',
    );

    // Audio encoding - only if source has audio (using -map 0:a?)
    args.push(
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '48000',
      '-ac', '1', // Mono
      '-movflags', '+faststart',
      OUTPUT_FILE,
    );

    addLog?.('info', 'Convert', `FFmpeg: CRF=${crf}, maxrate=${effectiveMaxRate}k, bufsize=${bufSize}k, scale=${scaleFilter || 'none'}`);

    return args;
  };

  const convert = useCallback(async (
    file: File,
    quality: QualityPreset,
    onStageChange?: (stage: ConversionStage) => void,
    videoDuration?: number | null,
    sourceWidth?: number | null,
    sourceHeight?: number | null
  ): Promise<ConversionResult> => {
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

    // Pre-cleanup: Remove any leftover files from previous conversion
    addLog?.('info', 'Cleanup', 'Temizlik: önceki dosyalar kontrol ediliyor...');
    await preCleanup();

    // Reset refs for new conversion
    maxEncodedTimeRef.current = 0;
    
    // Store video duration for progress calculation
    // If we have HTML5 metadata, use it; otherwise, we'll use FFmpeg fallback
    const validVideoDuration = videoDuration ?? null;
    hasHtml5MetadataRef.current = validVideoDuration !== null && validVideoDuration > 0;
    videoDurationRef.current = validVideoDuration;
    
    if (validVideoDuration !== null && validVideoDuration > 0) {
      addLog?.('info', 'Convert', `Video süresi (HTML5): ${validVideoDuration.toFixed(2)} sn`);
    } else {
      addLog?.('info', 'Convert', 'Video süresi: FFmpeg fallback kullanılacak');
    }
    if (sourceWidth && sourceHeight) {
      addLog?.('info', 'Convert', `Çözünürlük: ${sourceWidth}x${sourceHeight}`);
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
      cleanupStatus: 'idle',
      totalDuration: validVideoDuration,
      metadataSource: hasHtml5MetadataRef.current ? 'html5' : null,
    });

    // Get quality preset settings (matching WebCodecs qualityConfig values)
    // CRF values: lower = better quality, higher = worse quality
    // maxrate values are in kbps to match FFmpeg's expected format
    // These values are optimized for map/text readability
    const qualitySettingsMap: Record<QualityPreset, { crf: number; maxrate: number }> = {
      // Consistent with qualityConfig.ts for 720p vertical video
      small: { crf: 30, maxrate: 600 },    // ~600 kbps target - minimum for map text
      standard: { crf: 26, maxrate: 1000 }, // ~1 Mbps target
      high: { crf: 20, maxrate: 1800 },    // ~1.8 Mbps target
    };
    const { crf, maxrate } = qualitySettingsMap[quality];

    const deviceMemory = getDeviceMemory();
    const cpuCores = getCPUCores();
    const mobile = isMobileDevice();
    addLog?.('info', 'Convert', `Cihaz: Hafıza=${deviceMemory || 'bilinmiyor'}GB, Çekirdek=${cpuCores}, Mobil=${mobile}`);
    addLog?.('info', 'Convert', `Dosya boyutu: ${(file.size / (1024 * 1024)).toFixed(2)}MB, CRF=${crf}, maxrate=${maxrate}k`);

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
    updateProgress(0, 'converting', false, null, null, videoDurationRef.current);
    const execStartTime = Date.now();
    addLog?.('info', 'Convert', 'EXEC_STARTED');
    updateDebugInfo?.({ ffmpegExecStatus: 'running', ffmpegExecStartTime: execStartTime });

    const ffmpegArgs = buildFFmpegArgs(
      crf,
      maxrate,
      false, 
      sourceWidth ?? null, 
      sourceHeight ?? null
    );
    addLog?.('info', 'FFmpeg', `Komut: ${ffmpegArgs.join(' ')}`);

    let maxDuplicatedFrames = 0;
    let hasWarnedAboutDuplicates = false;
    let hasRetriedWithFallback = false;
    let lastProgressPercent = 0;

    // Calculate progress percentage based on encoded time and video duration
    // Formula: (encodedTime / totalDuration) * 100
    // Caps at 99% until completion, never goes backwards
    const calculateProgressPercent = (encodedTime: number | null): number => {
      const duration = videoDurationRef.current;
      
      // Validate duration - must be a reasonable positive value
      if (duration === null || duration <= 0.1) {
        // Duration too small or invalid - don't update progress
        return lastProgressPercent;
      }
      
      if (encodedTime === null) {
        // No encoded time - return current progress
        return lastProgressPercent;
      }
      
      // Sanity check: if encoded time is unreasonably large compared to duration, something is wrong
      if (encodedTime > duration * 1.05) {
        // Encoded time exceeds duration - likely duration was wrong
        // Don't update progress to avoid jumping to 99%
        return lastProgressPercent;
      }
      
      const rawPercent = (encodedTime / duration) * 100;
      const newPercent = Math.floor(Math.min(99, rawPercent));
      // Progress never goes backwards
      return Math.max(lastProgressPercent, newPercent);
    };

    // Progress handler
    progressHandlerRef.current = (data: { progress: number; time?: number }) => {
      lastActivityRef.current = Date.now();
      const normalizedProgress = data.progress;
      if (normalizedProgress > 0 && normalizedProgress <= 1) {
        lastProgressPercent = calculateProgressPercent(null);
        updateProgress(lastProgressPercent, 'converting', true, null, null, videoDurationRef.current);
        updateDebugInfo?.({ lastProgressValue: lastProgressPercent });
      }
    };
    ffmpeg.on('progress', progressHandlerRef.current);

    // Audio detection flag
    let hasAudioDetected = false;
    let conversionSucceeded = false;
    let ffmpegFallbackLogged = false;

    // FFmpeg log handler
    const ffmpegLogHandler = ({ message }: { message: string }) => {
      lastActivityRef.current = Date.now();
      
      // Detect audio stream in FFmpeg output
      // Only count as audio if it's NOT "audio:0kB" which means no audio
      if (!hasAudioDetected && /Audio:/i.test(message) && !/audio:0kB/i.test(message)) {
        hasAudioDetected = true;
        addLog?.('info', 'Convert', 'Audio stream detected - AAC encoding enabled');
      }
      
      // Detect when there's NO audio (audio:0kB)
      if (/audio:0kB/i.test(message)) {
        hasAudioDetected = false;
        addLog?.('info', 'Convert', 'Çıktıda ses bulunamadı (audio:0kB)');
      }
      
      // Ignore "Aborted()" messages that occur after successful completion
      // These are normal - they happen when worker is terminated after cleanup
      if (conversionSucceeded && /Aborted\(\)/i.test(message)) {
        return; // Skip logging aborted errors after success
      }
      
      // Also filter out "Aborted()" during cleanup - log at debug level
      if (/Aborted\(\)/i.test(message)) {
        // Don't log this as an error - it's expected during cleanup
        return;
      }
      
      if (message === lastFFmpegMessageRef.current) return;
      lastFFmpegMessageRef.current = message;
      
      const stats = parseFFmpegProgress(message);
      if (stats) {
        // Update last encoded time reference
        if (stats.encodedTime !== null) {
          lastEncodedTimeRef.current = stats.encodedTime;
          
          // Track max encoded time for FFmpeg fallback
          if (stats.encodedTime > maxEncodedTimeRef.current) {
            maxEncodedTimeRef.current = stats.encodedTime;
          }
          
          // If HTML5 metadata failed, use FFmpeg fallback for total duration
          if (!hasHtml5MetadataRef.current && videoDurationRef.current === null && maxEncodedTimeRef.current > 0) {
            // Use the max encoded time as the total duration
            videoDurationRef.current = maxEncodedTimeRef.current;
            updateDebugInfo?.({ 
              totalDuration: maxEncodedTimeRef.current,
              metadataSource: 'ffmpeg_fallback',
            });
            if (!ffmpegFallbackLogged) {
              ffmpegFallbackLogged = true;
              addLog?.('info', 'Convert', `Video süresi (FFmpeg fallback): ${maxEncodedTimeRef.current.toFixed(2)} sn`);
            }
          }
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
          updateProgress(lastProgressPercent, 'converting', true, stats.encodedTime, stats.encodingSpeed, videoDurationRef.current);
          updateDebugInfo?.({ lastProgressValue: lastProgressPercent });
        } else if (stats.encodedFrame !== null && stats.encodedFrame > 0) {
          // Fallback: animate progress for unknown duration
          updateProgress(lastProgressPercent, 'converting', true, null, stats.encodingSpeed, videoDurationRef.current);
        }
      }

      addLog?.('info', 'FFmpeg', message);
    };
    ffmpeg.on('log', ffmpegLogHandler);

    // Reset activity timer for execution
    lastActivityRef.current = Date.now();
    lastEncodedTimeRef.current = null;
    
    // Log audio detection status
    if (hasAudioDetected) {
      addLog?.('info', 'Convert', 'Audio stream detected - AAC encoding enabled');
    } else {
      addLog?.('info', 'Convert', 'No audio stream detected');
    }

    // Stall timeout - check every 10 seconds
    let stallCheckInterval: ReturnType<typeof setInterval> | null = null;
    stallCheckInterval = setInterval(async () => {
      const timeSinceLastActivity = Date.now() - lastActivityRef.current;
      if (timeSinceLastActivity >= STALL_TIMEOUT_MS) {
        if (stallCheckInterval) {
          clearInterval(stallCheckInterval);
          stallCheckInterval = null;
        }
        addLog?.('error', 'Convert', `STALL_DETECTED: 90 saniye aktivite yok`);
        
        // Terminate and cleanup - this will handle the error state
        await cleanupResources({ terminateWorker: true, reason: 'Stall timeout' });
        
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
    safetyTimeoutRef.current = setTimeout(async () => {
      if (stallCheckInterval) {
        clearInterval(stallCheckInterval);
        stallCheckInterval = null;
      }
      addLog?.('error', 'Convert', `SAFETY_TIMEOUT: 30 dakika aşıldı`);
      
      // Terminate and cleanup
      await cleanupResources({ terminateWorker: true, reason: 'Safety timeout (30 min)' });
      
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
        
        const fallbackArgs = buildFFmpegArgs(
          crf,
          maxrate,
          true, 
          sourceWidth ?? null, 
          sourceHeight ?? null
        );
        addLog?.('info', 'FFmpeg', `Fallback Komut: ${fallbackArgs.join(' ')}`);
        
        progressHandlerRef.current = (data: { progress: number }) => {
          lastActivityRef.current = Date.now();
          const normalizedProgress = data.progress;
          if (normalizedProgress > 0 && normalizedProgress <= 1) {
            lastProgressPercent = calculateProgressPercent(null);
            updateProgress(lastProgressPercent, 'converting', true, null, null, videoDurationRef.current);
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
              
              // Track max encoded time for FFmpeg fallback
              if (stats.encodedTime > maxEncodedTimeRef.current) {
                maxEncodedTimeRef.current = stats.encodedTime;
              }
              
              // If HTML5 metadata failed, use FFmpeg fallback for total duration
              if (!hasHtml5MetadataRef.current && videoDurationRef.current === null && maxEncodedTimeRef.current > 0) {
                videoDurationRef.current = maxEncodedTimeRef.current;
                updateDebugInfo?.({ 
                  totalDuration: maxEncodedTimeRef.current,
                  metadataSource: 'ffmpeg_fallback',
                });
                if (!ffmpegFallbackLogged) {
                  ffmpegFallbackLogged = true;
                  addLog?.('info', 'Convert', `Video süresi (FFmpeg fallback): ${maxEncodedTimeRef.current.toFixed(2)} sn`);
                }
              }
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
              updateProgress(lastProgressPercent, 'converting', true, stats.encodedTime, stats.encodingSpeed, videoDurationRef.current);
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
      
      const execErrorMessage = execError instanceof Error ? execError.message : String(execError);
      const errorObj: ConversionError = {
        code: 'CONVERSION_ERROR',
        message: 'Video dönüştürülürken bir hata oluştu.',
        technical: `ffmpeg.exec() başarısız\nHata: ${execErrorMessage}`,
      };
      setError(errorObj);
      updateDebugInfo?.({ errorCode: 'CONVERSION_ERROR', errorMessage: errorObj.message });
      onStageChange?.('error');
      throw execError;
    }

    // Step 4: Read output
    onStageChange?.('finalizing');
    updateProgress(99, 'finalizing', true, null, null, videoDurationRef.current);
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
    updateProgress(100, 'complete', true, null, null, videoDurationRef.current);

    // Keep all debug statuses as completed (don't reset to idle)
    updateDebugInfo?.({
      ffmpegExecStatus: 'completed',
      fileWriteStatus: 'written',
      ffmpegLoadStatus: 'loaded',
      coreJsLoadStatus: 'loaded',
      wasmLoadStatus: 'loaded',
    });

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
    const conversionTime = (Date.now() - startTimeRef.current) / 1000;
    const encodeTime = (Date.now() - execStartTime) / 1000; // Only FFmpeg execution time
    const inputSize = file.size; // Use original file size for accurate compression calculation
    const outputSize = blob.size;
    const compressionRatio = Math.round(((inputSize - outputSize) / inputSize) * 100);
    
    // Use the video duration from metadata or FFmpeg fallback
    const videoDurationSeconds = videoDurationRef.current ?? maxEncodedTimeRef.current;
    // Validate video duration - if it's unreasonably small compared to processed time, use processed time
    const finalVideoDuration = (videoDurationSeconds > 0 && videoDurationSeconds > maxEncodedTimeRef.current * 0.5) 
      ? videoDurationSeconds 
      : maxEncodedTimeRef.current;
    
    // Calculate bitrates based on video duration (FFmpeg gives kbps directly, no need to multiply)
    const videoBitrateKbps = finalVideoDuration > 0 ? (outputSize * 8 / 1000 / finalVideoDuration) : null;
    // Use actual audio bitrate if audio was present, otherwise 0
    const audioBitrateKbps = hasAudioDetected ? 96 : 0;
    const totalBitrateKbps = videoBitrateKbps !== null ? videoBitrateKbps + audioBitrateKbps : null;
    
    // Calculate average encoding speed (video seconds per wall clock second)
    const averageSpeed = encodeTime > 0 ? (finalVideoDuration / encodeTime) : null;
    
    addLog?.('success', 'Convert', `CONVERSION_COMPLETE: ${conversionTime.toFixed(1)} sn`);
    addLog?.('info', 'Convert', `Input: ${(inputSize / (1024 * 1024)).toFixed(2)}MB`);
    addLog?.('info', 'Convert', `Output: ${(outputSize / (1024 * 1024)).toFixed(2)}MB`);
    addLog?.('info', 'Convert', `Compression: ${compressionRatio}%`);
    addLog?.('info', 'Convert', `Video süresi: ${finalVideoDuration.toFixed(2)}sn, Encode süresi: ${encodeTime.toFixed(1)}s, Hız: ${averageSpeed?.toFixed(2) ?? '-'}x`);
    if (totalBitrateKbps !== null) {
      addLog?.('info', 'Convert', `Total bitrate: ${totalBitrateKbps.toFixed(0)}kbps`);
    }
    if (!hasAudioDetected) {
      addLog?.('info', 'Convert', 'Ses: Çıktıda ses bulunamadı');
    }

    // Update debug info with compression and encoding stats
    updateDebugInfo?.({
      inputSize,
      outputSize,
      compressionRatio,
      videoBitrate: videoBitrateKbps,
      audioBitrate: audioBitrateKbps,
      totalBitrate: totalBitrateKbps,
      encodeTime,
      averageSpeed,
      totalDuration: finalVideoDuration,
      actualEngineUsed: 'ffmpeg',
    });

    // Mark conversion as succeeded before cleanup (used by log handler to ignore abort errors)
    conversionSucceeded = true;

    // Perform cleanup - keeps FFmpeg worker alive
    await cleanupResources({ terminateWorker: false, reason: 'Success' });

    return {
      blob,
      fileName: getOutputFileName(file.name),
      fileSize: blob.size,
      videoDuration: finalVideoDuration,
      conversionTime,
      inputSize,
      outputSize,
      compressionRatio,
      videoBitrate: videoBitrateKbps ?? undefined,
      audioBitrate: audioBitrateKbps,
      totalBitrate: totalBitrateKbps ?? undefined,
      encodeTime,
      averageSpeed: averageSpeed ?? undefined,
      hasAudio: hasAudioDetected,
      engine: 'ffmpeg-wasm',
    };
  }, [updateProgress, clearAllTimeouts, addLog, updateDebugInfo, normalizeError, cleanupResources, preCleanup]);

  const terminate = useCallback(async (reason: string = 'User requested') => {
    const ffmpeg = ffmpegRef.current;
    
    // Clear listeners
    if (logHandlerRef.current && ffmpeg) {
      ffmpeg.off('log', logHandlerRef.current);
      logHandlerRef.current = null;
    }
    if (progressHandlerRef.current && ffmpeg) {
      ffmpeg.off('progress', progressHandlerRef.current);
      progressHandlerRef.current = null;
    }
    
    clearAllTimeouts();
    
    // Terminate worker
    if (ffmpeg) {
      try {
        ffmpeg.terminate();
      } catch {
        // Ignore terminate errors
      }
    }
    
    ffmpegRef.current = null;
    setIsLoaded(false);
    fileDataRef.current = null;
    
    // Update status - don't reset everything, keep debug info for debugging
    updateDebugInfo?.({ 
      ffmpegExecStatus: 'error',
      cleanupStatus: 'completed',
    });
    
    setProgress({ percent: 0, time: 0, stage: 'idle', hasProgress: false, encodedTime: null, encodingSpeed: null, totalDuration: null });
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
