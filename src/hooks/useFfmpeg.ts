'use client';

import { useCallback, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { 
  ConversionProgress, 
  ConversionResult, 
  ConversionError,
  QualityPreset,
  ConversionStage,
  MediaInfo,
} from '@/types/converter';
import { getOutputFileName } from '@/lib/file-utils';

const INPUT_FILE = 'input.webm';
const ANALYZE_FILE = 'analyze.webm';
const OUTPUT_FILE = 'output.mp4';

// Timeout values
const MOBILE_EXEC_TIMEOUT_MS = 180000; // 180 seconds for mobile
const DESKTOP_EXEC_TIMEOUT_MS = 300000; // 300 seconds for desktop
const STALL_TIMEOUT_MS = 90000; // 90 seconds stall detection
const DUPLICATE_FRAME_WARNING_THRESHOLD = 100; // Warn when dup > 100
const DUPLICATE_FRAME_ABORT_THRESHOLD = 1000; // Abort and retry when dup > 1000

interface EncoderValidation {
  h264: boolean;
  aac: boolean;
}

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
  analyzeMedia: (file: File) => Promise<MediaInfo>;
  convert: (
    file: File,
    quality: QualityPreset,
    mediaInfo: MediaInfo,
    onStageChange?: (stage: ConversionStage) => void
  ) => Promise<ConversionResult>;
  terminate: () => void;
}

// Check if device is mobile using simple userAgent check
function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent;
  return /Android|iPhone|iPad|iPod/i.test(userAgent);
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

// Parse FFmpeg progress line: frame=1167 time=00:00:01.16 dup=1134 speed=0.00753x
function parseFFmpegProgress(line: string): FFmpegLogStats | null {
  const stats: FFmpegLogStats = {
    encodedFrame: null,
    encodedTime: null,
    encodingFps: null,
    duplicatedFrames: null,
    encodingSpeed: null,
  };

  // Parse frame
  const frameMatch = line.match(/frame=\s*(\d+)/);
  if (frameMatch) stats.encodedFrame = parseInt(frameMatch[1], 10);

  // Parse time
  const timeMatch = line.match(/time=\s*(\d{2}):(\d{2}):(\d{2}\.?\d*)/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseFloat(timeMatch[3]);
    stats.encodedTime = hours * 3600 + minutes * 60 + seconds;
  }

  // Parse fps
  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  if (fpsMatch) stats.encodingFps = parseFloat(fpsMatch[1]);

  // Parse dup (duplicated frames)
  const dupMatch = line.match(/dup=\s*(\d+)/);
  if (dupMatch) stats.duplicatedFrames = parseInt(dupMatch[1], 10);

  // Parse speed
  const speedMatch = line.match(/speed=\s*([\d.]+)x/);
  if (speedMatch) stats.encodingSpeed = parseFloat(speedMatch[1]);

  // Return null if no valid stats found
  if (stats.encodedFrame === null && stats.encodedTime === null) {
    return null;
  }

  return stats;
}

export function useFfmpeg(debugCallbacks?: DebugCallbacks): UseFfmpegReturn {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fileDataRef = useRef<Uint8Array | null>(null);
  const encoderValidationRef = useRef<EncoderValidation | null>(null);
  const logHandlerRef = useRef<((data: { message: string }) => void) | null>(null);
  const progressHandlerRef = useRef<((data: { progress: number }) => void) | null>(null);
  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const ffmpegLogHandlerRef = useRef<((data: { message: string }) => void) | null>(null);
  const lastFFmpegMessageRef = useRef<string>(''); // Prevent duplicate log messages
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ConversionProgress>({
    percent: 0,
    time: 0,
    stage: 'idle',
    hasProgress: false,
  });
  const [error, setError] = useState<ConversionError | null>(null);

  const startTimeRef = useRef<number>(Date.now());

  const { addLog, updateDebugInfo } = debugCallbacks || {};

  // Normalize error to extract message and stack
  const normalizeError = (err: unknown): { message: string; stack: string | null } => {
    if (err instanceof Error) {
      return { message: err.message, stack: err.stack || null };
    }
    return { message: String(err), stack: null };
  };

  // Clear all timeouts
  const clearAllTimeouts = useCallback(() => {
    if (progressTimeoutRef.current) {
      clearTimeout(progressTimeoutRef.current);
      progressTimeoutRef.current = null;
    }
    if (stallTimeoutRef.current) {
      clearTimeout(stallTimeoutRef.current);
      stallTimeoutRef.current = null;
    }
  }, []);

  const updateProgress = useCallback((percent: number, stage: ConversionStage, hasProgress = true) => {
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    setProgress({
      percent: Math.min(Math.max(percent, 0), 100),
      time: elapsed,
      stage,
      hasProgress,
    });
  }, []);

  const cleanupFFmpegFiles = useCallback(async (ffmpeg: FFmpeg, fileName: string) => {
    try {
      await ffmpeg.deleteFile(fileName);
    } catch {
      // File might not exist, ignore
    }
  }, []);

  const cleanupAllFiles = useCallback(async (ffmpeg: FFmpeg) => {
    await cleanupFFmpegFiles(ffmpeg, INPUT_FILE);
    await cleanupFFmpegFiles(ffmpeg, ANALYZE_FILE);
    await cleanupFFmpegFiles(ffmpeg, OUTPUT_FILE);
  }, [cleanupFFmpegFiles]);

  const checkEncoders = useCallback(async (ffmpeg: FFmpeg): Promise<EncoderValidation> => {
    const validation: EncoderValidation = { h264: false, aac: false };

    return new Promise((resolve) => {
      const logs: string[] = [];
      
      const handler = ({ message }: { message: string }) => {
        logs.push(message);
        if (message.includes('libx264')) validation.h264 = true;
        if (message.includes('aac')) validation.aac = true;
      };
      
      logHandlerRef.current = handler;
      ffmpeg.on('log', handler);
      
      ffmpeg.exec(['-encoders']).then(() => {
        ffmpeg.off('log', handler);
        logHandlerRef.current = null;
        resolve(validation);
      }).catch(() => {
        ffmpeg.off('log', handler);
        logHandlerRef.current = null;
        resolve(validation);
      });
    });
  }, []);

  const parseMediaInfo = useCallback(async (
    ffmpeg: FFmpeg, 
    file: File, 
    fileName: string
  ): Promise<MediaInfo> => {
    return new Promise((resolve) => {
      const logs: string[] = [];
      
      const handler = ({ message }: { message: string }) => {
        logs.push(message);
      };
      
      logHandlerRef.current = handler;
      ffmpeg.on('log', handler);
      
      ffmpeg.exec(['-i', fileName, '-f', 'null', '-']).then(() => {
        ffmpeg.off('log', handler);
        logHandlerRef.current = null;
        
        const fullLog = logs.join('\n');
        
        const info: MediaInfo = {
          fileName: file.name,
          fileSize: file.size,
          videoCodec: null,
          resolution: null,
          frameRate: null,
          bitrate: null,
          duration: null,
          hasAudio: false,
          audioCodec: null,
          audioBitrate: null,
          audioSampleRate: null,
        };
        
        const videoMatch = fullLog.match(/Video:\s*(\w+)/);
        if (videoMatch) info.videoCodec = videoMatch[1];
        
        const dimsMatch = fullLog.match(/(\d+)x(\d+)/);
        if (dimsMatch) info.resolution = `${dimsMatch[1]}x${dimsMatch[2]}`;
        
        const fpsMatch = fullLog.match(/(\d+(?:\.\d+)?)\s*fps/);
        if (fpsMatch) info.frameRate = parseFloat(fpsMatch[1]);
        
        const durationMatch = fullLog.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseInt(durationMatch[3]);
          const ms = parseInt(durationMatch[4]);
          info.duration = hours * 3600 + minutes * 60 + seconds + ms / 100;
        }
        
        const bitrateMatch = fullLog.match(/bitrate:\s*(\d+)\s*kb/);
        if (bitrateMatch) info.bitrate = parseInt(bitrateMatch[1]);
        
        const audioMatch = fullLog.match(/Audio:\s*(\w+)[^\r\n]*/);
        if (audioMatch) {
          info.hasAudio = true;
          info.audioCodec = audioMatch[1];
          
          const audioBitrateMatch = audioMatch[0].match(/(\d+)\s*kb/);
          if (audioBitrateMatch) info.audioBitrate = parseInt(audioBitrateMatch[1]);
          
          const sampleRateMatch = audioMatch[0].match(/(\d+)\s*Hz/);
          if (sampleRateMatch) info.audioSampleRate = parseInt(sampleRateMatch[1]);
        }
        
        resolve(info);
      }).catch(() => {
        ffmpeg.off('log', handler);
        logHandlerRef.current = null;
        
        resolve({
          fileName: file.name,
          fileSize: file.size,
          videoCodec: null,
          resolution: null,
          frameRate: null,
          bitrate: null,
          duration: null,
          hasAudio: false,
          audioCodec: null,
          audioBitrate: null,
          audioSampleRate: null,
        });
      });
    });
  }, []);

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

      // Only set up log handler once during load (not during conversion)
      const loadLogHandler = ({ message }: { message: string }) => {
        console.log('[FFmpeg]', message);
      };
      ffmpeg.on('log', loadLogHandler);

      updateDebugInfo?.({ coreJsLoadStatus: 'loading', wasmLoadStatus: 'loading' });
      addLog?.('info', 'Load', 'Core JS yükleniyor: /ffmpeg/ffmpeg-core.js');
      
      await ffmpeg.load({
        coreURL: '/ffmpeg/ffmpeg-core.js',
        wasmURL: '/ffmpeg/ffmpeg-core.wasm',
      });
      
      updateDebugInfo?.({ coreJsLoadStatus: 'loaded', wasmLoadStatus: 'loaded' });
      addLog?.('success', 'Load', 'Core JS yüklendi');
      addLog?.('success', 'Load', 'WASM yüklendi');

      ffmpegRef.current = ffmpeg;

      updateDebugInfo?.({ encoderValidationStatus: 'validating' });
      addLog?.('info', 'Load', 'Encoder doğrulama başlatılıyor');
      const validation = await checkEncoders(ffmpeg);
      
      encoderValidationRef.current = validation;
      updateDebugInfo?.({ 
        encoderValidationStatus: 'completed',
        encoderValidationResult: validation,
        ffmpegLoadStatus: 'loaded',
      });
      addLog?.('success', 'Load', `Encoder doğrulama tamamlandı: H.264=${validation.h264}, AAC=${validation.aac}`);

      if (!validation.h264) {
        addLog?.('error', 'Load', 'H.264 encoder bulunamadı');
        throw new Error('H264_NOT_FOUND');
      }

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
      
      if (message === 'H264_NOT_FOUND' || message.includes('H264')) {
        errorMessage = 'Bu tarayıcıda gerekli H.264 dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.';
        errorCode = 'H264_NOT_FOUND';
      } else if (message.includes('fetch') || message.includes('network') || message.includes('Failed to') || message.includes('404')) {
        errorMessage = 'FFmpeg dosyaları yüklenemedi. Lütfen internet bağlantınızı kontrol edin.';
        errorCode = 'FFMPEG_FETCH_ERROR';
      } else if (message.includes('WASM') || message.includes('wasm')) {
        errorMessage = 'WebAssembly yüklenemedi. Lütfen sayfayı yenileyin.';
        errorCode = 'WASM_LOAD_ERROR';
      }
      
      const errorObj: ConversionError = {
        code: errorCode,
        message: errorMessage,
        technical: `ffmpeg.load() başarısız\nURLs: /ffmpeg/ffmpeg-core.js, /ffmpeg/ffmpeg-core.wasm\n${message}\nStack: ${stack || 'yok'}`,
      };
      setError(errorObj);
      updateProgress(0, 'error', false);
      return false;
    } finally {
      clearTimeout(loadTimeout);
      setIsLoading(false);
    }
  }, [isLoading, updateProgress, checkEncoders, addLog, updateDebugInfo, normalizeError]);

  const analyzeMedia = useCallback(async (file: File): Promise<MediaInfo> => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      throw new Error('FFmpeg henüz yüklenmedi');
    }

    try {
      const fileData = new Uint8Array(await file.arrayBuffer());
      await ffmpeg.writeFile(ANALYZE_FILE, fileData);
      const mediaInfo = await parseMediaInfo(ffmpeg, file, ANALYZE_FILE);
      return mediaInfo;
    } finally {
      await cleanupFFmpegFiles(ffmpeg, ANALYZE_FILE);
    }
  }, [parseMediaInfo, cleanupFFmpegFiles]);

  // Helper function to build FFmpeg arguments
  const buildFFmpegArgs = (
    hasAudio: boolean,
    crf: number,
    useFallback: boolean
  ): string[] => {
    const mobile = isMobileDevice();
    const args: string[] = ['-fflags', '+genpts', '-i', INPUT_FILE];

    if (useFallback) {
      // Fallback command with setpts filter for timestamp issues
      args.push('-vf', 'setpts=N/(30*TB),fps=30', '-fps_mode', 'cfr');
      addLog?.('info', 'Convert', 'Fallback komut kullanılıyor (setpts filtresi ile)');
    } else {
      // Normal command with fps filter
      args.push('-vf', 'fps=30', '-fps_mode', 'cfr');
    }

    args.push('-c:v', 'libx264');

    // Mobile uses ultrafast, desktop uses veryfast
    if (mobile) {
      args.push('-preset', 'ultrafast', '-threads', '1');
    } else {
      args.push('-preset', 'veryfast', '-threads', '1');
    }

    args.push('-crf', crf.toString(), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');

    if (hasAudio) {
      args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000');
    } else {
      args.push('-an');
    }

    args.push(OUTPUT_FILE);
    return args;
  };

  const convert = useCallback(async (
    file: File,
    quality: QualityPreset,
    mediaInfo: MediaInfo,
    onStageChange?: (stage: ConversionStage) => void
  ): Promise<ConversionResult> => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      const err = new Error('FFmpeg henüz yüklenmedi');
      addLog?.('error', 'Convert', `HATA: FFmpeg nesnesi mevcut değil`);
      updateDebugInfo?.({ 
        errorMessage: 'FFmpeg nesnesi mevcut değil',
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'FFMPEG_NOT_LOADED',
        message: 'FFmpeg henüz yüklenmedi.',
        technical: `ffmpegRef.current is null`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    const validation = encoderValidationRef.current;
    if (!validation) {
      const err = new Error('Encoder doğrulaması yapılmadı');
      addLog?.('error', 'Convert', `HATA: Encoder doğrulaması yapılmadı`);
      updateDebugInfo?.({ 
        errorMessage: 'Encoder doğrulaması yapılmadı',
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'ENCODER_NOT_VALIDATED',
        message: 'Dönüştürücü hazır değil.',
        technical: `encoderValidationRef.current is null`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    if (!validation.h264) {
      const err = new Error('H.264 encoder mevcut değil');
      addLog?.('error', 'Convert', `HATA: H.264 encoder mevcut değil`);
      updateDebugInfo?.({ 
        errorMessage: 'H.264 encoder mevcut değil',
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'H264_ENCODER_UNAVAILABLE',
        message: 'Bu tarayıcıda gerekli H.264 dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.',
        technical: `H.264 encoder not found\nvalidation.h264 = ${validation.h264}`,
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
      errorStack: null,
    });

    const crfMap: Record<QualityPreset, number> = {
      high: 18,
      balanced: 23,
      small: 28,
    };
    const crf = crfMap[quality];

    // Log device info
    const deviceMemory = getDeviceMemory();
    const cpuCores = getCPUCores();
    const mobile = isMobileDevice();
    addLog?.('info', 'Convert', `Cihaz: Hafıza=${deviceMemory || 'bilinmiyor'}GB, Çekirdek=${cpuCores}, Mobil=${mobile}`);
    addLog?.('info', 'Convert', `Video: ${mediaInfo.resolution || 'bilinmiyor'}, Süre=${mediaInfo.duration?.toFixed(1) || 'bilinmiyor'}sn, CRF=${crf}`);

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
      updateDebugInfo?.({ 
        errorMessage: `Dosya okunamadı: ${message}`, 
        errorStack: stack 
      });
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
    addLog?.('info', 'Convert', `WRITE_FILE_STARTED: ${INPUT_FILE}`);
    updateDebugInfo?.({ fileWriteStatus: 'writing' });
    
    try {
      fileDataRef.current = fileData;
      await ffmpeg.writeFile(INPUT_FILE, fileData);
      updateDebugInfo?.({ fileWriteStatus: 'written' });
      addLog?.('success', 'Convert', `WRITE_FILE_SUCCESS: ${INPUT_FILE}`);
    } catch (err) {
      const { message, stack } = normalizeError(err);
      updateDebugInfo?.({ fileWriteStatus: 'error' });
      addLog?.('error', 'Convert', `WRITE_FILE_FAILED: ${message}`);
      updateDebugInfo?.({ 
        errorMessage: `Dosya FFmpeg VFS'ye yazılamadı: ${message}`, 
        errorStack: stack 
      });
      const errorObj: ConversionError = {
        code: 'WRITE_FILE_ERROR',
        message: 'Dosya FFmpeg VFS\'ye yazılamadı.',
        technical: `ffmpeg.writeFile("${INPUT_FILE}", ${fileData.byteLength} bytes) başarısız\n${message}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    const parsedMediaInfo = mediaInfo;
    if (!parsedMediaInfo) {
      const err = new Error('Medya bilgisi bulunamadı');
      addLog?.('error', 'Convert', `MEDIA_INFO_MISSING: ${err.message}`);
      updateDebugInfo?.({ 
        errorMessage: err.message, 
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'MEDIA_INFO_MISSING',
        message: err.message,
        technical: `mediaInfo is null`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    if (parsedMediaInfo.hasAudio && !validation.aac) {
      const err = new Error('AAC encoder mevcut değil - video sesli');
      addLog?.('error', 'Convert', `AAC_NOT_FOUND: ${err.message}`);
      updateDebugInfo?.({ 
        errorMessage: err.message,
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'AAC_ENCODER_UNAVAILABLE',
        message: 'Bu videoda ses var ancak AAC dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.',
        technical: `AAC encoder not available\nvalidation.aac = ${validation.aac}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }
  
    // Step 3: Execute FFmpeg
    onStageChange?.('converting');
    updateProgress(10, 'converting', false);
    addLog?.('info', 'Convert', 'EXEC_STARTED');
    updateDebugInfo?.({ ffmpegExecStatus: 'running', ffmpegExecStartTime: Date.now() });

    // Build FFmpeg args (normal mode first)
    const ffmpegArgs = buildFFmpegArgs(parsedMediaInfo.hasAudio, crf, false);
    addLog?.('info', 'FFmpeg', `Komut: ${ffmpegArgs.join(' ')}`);

    // Track duplicate frames for auto-retry
    let maxDuplicatedFrames = 0;
    let hasWarnedAboutDuplicates = false;
    let hasRetriedWithFallback = false;
    let lastProgressPercent = 10;

    // Progress handler - updates lastActivity
    progressHandlerRef.current = (data: { progress: number; time?: number }) => {
      lastActivityRef.current = Date.now();
      
      // Calculate progress from FFmpeg progress if available
      const normalizedProgress = data.progress;
      if (normalizedProgress > 0 && normalizedProgress <= 1) {
        lastProgressPercent = 10 + Math.round(normalizedProgress * 85);
        updateProgress(lastProgressPercent, 'converting', true);
        updateDebugInfo?.({ lastProgressValue: lastProgressPercent });
      }
    };
    ffmpeg.on('progress', progressHandlerRef.current);

    // FFmpeg log handler for activity tracking and duplicate frame detection
    const ffmpegLogHandler = ({ message }: { message: string }) => {
      lastActivityRef.current = Date.now();
      
      // Prevent duplicate log messages
      if (message === lastFFmpegMessageRef.current) {
        return;
      }
      lastFFmpegMessageRef.current = message;
      
      // Parse progress line
      const stats = parseFFmpegProgress(message);
      if (stats) {
        // Update debug info with parsed stats
        updateDebugInfo?.({
          encodedFrame: stats.encodedFrame,
          encodedTime: stats.encodedTime,
          encodingFps: stats.encodingFps,
          duplicatedFrames: stats.duplicatedFrames,
          encodingSpeed: stats.encodingSpeed,
        });

        // Track max duplicated frames
        if (stats.duplicatedFrames !== null) {
          if (stats.duplicatedFrames > maxDuplicatedFrames) {
            maxDuplicatedFrames = stats.duplicatedFrames;
          }

          // Warning when dup > 100
          if (stats.duplicatedFrames > DUPLICATE_FRAME_WARNING_THRESHOLD && !hasWarnedAboutDuplicates) {
            hasWarnedAboutDuplicates = true;
            addLog?.('warning', 'Convert', `Timestamp problemi: ${stats.duplicatedFrames} duplicate frame tespit edildi`);
          }
        }

        // Calculate progress from encoded time if duration is available
        if (stats.encodedTime !== null && parsedMediaInfo.duration && parsedMediaInfo.duration > 0) {
          const progressFromTime = 10 + (stats.encodedTime / parsedMediaInfo.duration) * 85;
          const percent = Math.min(95, Math.max(10, Math.round(progressFromTime)));
          if (percent > lastProgressPercent) {
            lastProgressPercent = percent;
            updateProgress(percent, 'converting', true);
            updateDebugInfo?.({ lastProgressValue: percent });
          }
        }
      }

      // Log to debug panel
      addLog?.('info', 'FFmpeg', message);
    };
    ffmpeg.on('log', ffmpegLogHandler);

    // Set up stall timeout (90 seconds)
    stallTimeoutRef.current = setTimeout(() => {
      const timeSinceLastActivity = Date.now() - lastActivityRef.current;
      if (timeSinceLastActivity >= STALL_TIMEOUT_MS) {
        addLog?.('error', 'Convert', `EXEC_TIMEOUT: 90 saniye aktivite yok`);
        updateDebugInfo?.({ ffmpegExecStatus: 'timeout' });
        
        // Terminate FFmpeg
        ffmpeg.terminate();
        ffmpegRef.current = null;
        setIsLoaded(false);
        
        clearAllTimeouts();
        ffmpeg.off('progress', progressHandlerRef.current!);
        ffmpeg.off('log', ffmpegLogHandler);
        progressHandlerRef.current = null;
        
        const errorObj: ConversionError = {
          code: 'EXEC_TIMEOUT',
          message: 'Dönüştürme cihazınızda yanıt vermedi. Video boyutu veya çözünürlüğü cihaz kapasitesini aşmış olabilir.',
          technical: `90 saniye boyunca aktivite yok\nSon aktivite: ${new Date(lastActivityRef.current).toISOString()}`,
        };
        setError(errorObj);
        updateDebugInfo?.({ errorCode: 'EXEC_TIMEOUT', errorMessage: errorObj.message });
        onStageChange?.('error');
      }
    }, STALL_TIMEOUT_MS);

    // Get timeout based on device type
    const execTimeout = isMobileDevice() ? MOBILE_EXEC_TIMEOUT_MS : DESKTOP_EXEC_TIMEOUT_MS;

    // Helper function to execute FFmpeg with timeout
    const execWithTimeout = async (args: string[]): Promise<void> => {
      await Promise.race([
        ffmpeg.exec(args),
        new Promise<void>((_, reject) => {
          progressTimeoutRef.current = setTimeout(() => {
            reject(new Error('EXEC_TIMEOUT'));
          }, execTimeout);
        })
      ]);
    };

    let execSuccess = false;
    let execError: Error | null = null;

    try {
      await execWithTimeout(ffmpegArgs);
      clearTimeout(progressTimeoutRef.current!);
      progressTimeoutRef.current = null;
      execSuccess = true;
      addLog?.('success', 'Convert', 'EXEC_SUCCESS');
      updateDebugInfo?.({ ffmpegExecStatus: 'completed' });
    } catch (err) {
      clearTimeout(progressTimeoutRef.current!);
      progressTimeoutRef.current = null;
      
      const { message, stack } = normalizeError(err);
      execError = err instanceof Error ? err : new Error(message);
      
      // If it's a timeout, terminate FFmpeg
      if (message === 'EXEC_TIMEOUT' || message.includes('timeout')) {
        addLog?.('error', 'Convert', `EXEC_TIMEOUT: ${isMobileDevice() ? '180' : '300'} saniye timeout`);
        updateDebugInfo?.({ ffmpegExecStatus: 'timeout' });
        
        try { ffmpeg.terminate(); } catch { /* ignore */ }
        ffmpegRef.current = null;
        setIsLoaded(false);
        
        const errorObj: ConversionError = {
          code: 'EXEC_TIMEOUT',
          message: 'Dönüştürme cihazınızda yanıt vermedi. Video boyutu veya çözünürlüğü cihaz kapasitesini aşmış olabilir.',
          technical: `${isMobileDevice() ? '180' : '300'} saniye timeout aşıldı\nKomut: ${ffmpegArgs.join(' ')}`,
        };
        setError(errorObj);
        updateDebugInfo?.({ errorCode: 'EXEC_TIMEOUT', errorMessage: errorObj.message });
        onStageChange?.('error');
        throw execError;
      }
      
      // Check if we should retry with fallback command
      // Only retry once and only if duplicate frames are high
      if (!hasRetriedWithFallback && maxDuplicatedFrames > DUPLICATE_FRAME_ABORT_THRESHOLD) {
        hasRetriedWithFallback = true;
        addLog?.('warning', 'Convert', `Çok fazla duplicate frame (${maxDuplicatedFrames}) - Fallback komutla yeniden deneniyor...`);
        
        // Clean up handlers
        ffmpeg.off('progress', progressHandlerRef.current!);
        ffmpeg.off('log', ffmpegLogHandler);
        progressHandlerRef.current = null;
        lastActivityRef.current = Date.now();
        maxDuplicatedFrames = 0;
        hasWarnedAboutDuplicates = false;
        lastProgressPercent = 10;
        lastFFmpegMessageRef.current = '';
        
        // Build fallback args and retry
        const fallbackArgs = buildFFmpegArgs(parsedMediaInfo.hasAudio, crf, true);
        addLog?.('info', 'FFmpeg', `Fallback Komut: ${fallbackArgs.join(' ')}`);
        
        // Re-setup handlers
        progressHandlerRef.current = (data: { progress: number; time?: number }) => {
          lastActivityRef.current = Date.now();
          const normalizedProgress = data.progress;
          if (normalizedProgress > 0 && normalizedProgress <= 1) {
            lastProgressPercent = 10 + Math.round(normalizedProgress * 85);
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

            if (stats.encodedTime !== null && parsedMediaInfo.duration && parsedMediaInfo.duration > 0) {
              const progressFromTime = 10 + (stats.encodedTime / parsedMediaInfo.duration) * 85;
              const percent = Math.min(95, Math.max(10, Math.round(progressFromTime)));
              if (percent > lastProgressPercent) {
                lastProgressPercent = percent;
                updateProgress(percent, 'converting', true);
                updateDebugInfo?.({ lastProgressValue: percent });
              }
            }
          }
          addLog?.('info', 'FFmpeg', message);
        };
        ffmpeg.on('log', retryLogHandler);
        
        try {
          await execWithTimeout(fallbackArgs);
          clearTimeout(progressTimeoutRef.current!);
          progressTimeoutRef.current = null;
          execSuccess = true;
          addLog?.('success', 'Convert', 'EXEC_SUCCESS (Fallback komut ile)');
          updateDebugInfo?.({ ffmpegExecStatus: 'completed' });
        } catch (retryErr) {
          clearTimeout(progressTimeoutRef.current!);
          progressTimeoutRef.current = null;
          const { message: retryMsg } = normalizeError(retryErr);
          execError = retryErr instanceof Error ? retryErr : new Error(retryMsg);
          ffmpeg.off('progress', progressHandlerRef.current!);
          ffmpeg.off('log', retryLogHandler);
        }
      }
    }
    
    // Clean up handlers
    clearAllTimeouts();
    ffmpeg.off('progress', progressHandlerRef.current!);
    ffmpeg.off('log', ffmpegLogHandler);
    progressHandlerRef.current = null;

    // Handle execution error if any
    if (!execSuccess && execError) {
      updateDebugInfo?.({ ffmpegExecStatus: 'error' });
      
      const errorMessage = 'Video dönüştürülürken bir sorun oluştu. Lütfen daha küçük bir dosyayla tekrar deneyin veya farklı bir tarayıcı kullanın.';
      const errorCode = 'CONVERSION_ERROR';

      const errorObj: ConversionError = {
        code: errorCode,
        message: errorMessage,
        technical: `ffmpeg.exec() başarısız\nKomut: ${ffmpegArgs.join(' ')}\nHata: ${execError.message}\nMax duplicate frames: ${maxDuplicatedFrames}`,
      };
      setError(errorObj);
      updateDebugInfo?.({ errorCode, errorMessage });
      onStageChange?.('error');
      throw execError;
    }

    // Step 4: Read output file
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
      updateDebugInfo?.({ 
        errorMessage: `MP4 dosyası okunamadı: ${message}`, 
        errorStack: stack 
      });
      const errorObj: ConversionError = {
        code: 'OUTPUT_READ_ERROR',
        message: 'MP4 dosyası okunamadı.',
        technical: `ffmpeg.readFile("${OUTPUT_FILE}") başarısız\n${message}`,
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
    updateDebugInfo?.({ fileWriteStatus: 'written' });

    // Cleanup
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
  }, [cleanupAllFiles, parseMediaInfo, updateProgress, clearAllTimeouts, addLog, updateDebugInfo, normalizeError]);

  const terminate = useCallback(() => {
    clearAllTimeouts();
    if (ffmpegRef.current) {
      if (logHandlerRef.current) {
        ffmpegRef.current.off('log', logHandlerRef.current);
        logHandlerRef.current = null;
      }
      if (ffmpegLogHandlerRef.current) {
        ffmpegRef.current.off('log', ffmpegLogHandlerRef.current);
        ffmpegLogHandlerRef.current = null;
      }
      if (progressHandlerRef.current) {
        ffmpegRef.current.off('progress', progressHandlerRef.current);
        progressHandlerRef.current = null;
      }
      
      ffmpegRef.current.terminate();
      ffmpegRef.current = null;
      setIsLoaded(false);
      encoderValidationRef.current = null;
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
    analyzeMedia,
    convert,
    terminate,
  };
}
