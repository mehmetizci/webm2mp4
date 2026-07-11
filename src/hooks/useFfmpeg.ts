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
const PROGRESS_TIMEOUT_MS = 30000; // 30 seconds timeout for progress events

interface EncoderValidation {
  h264: boolean;
  aac: boolean;
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
    mediaInfo: MediaInfo | null,
    onStageChange?: (stage: ConversionStage) => void
  ) => Promise<ConversionResult>;
  terminate: () => void;
}

export function useFfmpeg(debugCallbacks?: DebugCallbacks): UseFfmpegReturn {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fileDataRef = useRef<Uint8Array | null>(null);
  const encoderValidationRef = useRef<EncoderValidation | null>(null);
  const logHandlerRef = useRef<((data: { message: string }) => void) | null>(null);
  const progressHandlerRef = useRef<((data: { progress: number }) => void) | null>(null);
  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ConversionProgress>({
    percent: 0,
    time: 0,
    stage: 'idle',
    hasProgress: false, // Track if progress has started
  });
  const [error, setError] = useState<ConversionError | null>(null);

  const startTimeRef = useRef<number>(Date.now()); // Initialize immediately

  const { addLog, updateDebugInfo } = debugCallbacks || {};

  // Normalize error to extract message and stack
  const normalizeError = (err: unknown): { message: string; stack: string | null } => {
    if (err instanceof Error) {
      return { message: err.message, stack: err.stack || null };
    }
    return { message: String(err), stack: null };
  };

  // Safely normalize FFmpeg progress value (can be time, ratio, or invalid)
  const normalizeProgress = (rawProgress: unknown): number => {
    const p = typeof rawProgress === 'number' ? rawProgress : 0;
    
    // If progress is a time value (large number like 30000), ignore it
    // If progress is negative or invalid, ignore it
    // If progress is > 1 (but not a time), treat as ratio
    if (p < 0 || !isFinite(p)) {
      return -1; // Invalid
    }
    
    // If it's a very large number, it's likely a time value in seconds
    // We can't use time directly without knowing total duration
    if (p > 1) {
      return -1; // Treat as invalid, don't update progress
    }
    
    // Progress should be between 0 and 1
    return Math.max(0, Math.min(1, p));
  };

  const clearProgressTimeout = useCallback(() => {
    if (progressTimeoutRef.current) {
      clearTimeout(progressTimeoutRef.current);
      progressTimeoutRef.current = null;
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
    console.log('[Progress] Stage:', stage, '| Percent:', percent, '| Time:', elapsed.toFixed(1) + 's');
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
    const validation: EncoderValidation = {
      h264: false,
      aac: false,
    };

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
        
        if (process.env.NODE_ENV === 'development') {
          console.log('[FFmpeg] Encoder validation:', validation);
        }
        
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
        if (videoMatch) {
          info.videoCodec = videoMatch[1];
        }
        
        const dimsMatch = fullLog.match(/(\d+)x(\d+)/);
        if (dimsMatch) {
          info.resolution = `${dimsMatch[1]}x${dimsMatch[2]}`;
        }
        
        const fpsMatch = fullLog.match(/(\d+(?:\.\d+)?)\s*fps/);
        if (fpsMatch) {
          info.frameRate = parseFloat(fpsMatch[1]);
        }
        
        const durationMatch = fullLog.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseInt(durationMatch[3]);
          const ms = parseInt(durationMatch[4]);
          info.duration = hours * 3600 + minutes * 60 + seconds + ms / 100;
        }
        
        const bitrateMatch = fullLog.match(/bitrate:\s*(\d+)\s*kb/);
        if (bitrateMatch) {
          info.bitrate = parseInt(bitrateMatch[1]);
        }
        
        const audioMatch = fullLog.match(/Audio:\s*(\w+)[^\r\n]*/);
        if (audioMatch) {
          info.hasAudio = true;
          info.audioCodec = audioMatch[1];
          
          const audioBitrateMatch = audioMatch[0].match(/(\d+)\s*kb/);
          if (audioBitrateMatch) {
            info.audioBitrate = parseInt(audioBitrateMatch[1]);
          }
          
          const sampleRateMatch = audioMatch[0].match(/(\d+)\s*Hz/);
          if (sampleRateMatch) {
            info.audioSampleRate = parseInt(sampleRateMatch[1]);
          }
        }
        
        if (process.env.NODE_ENV === 'development') {
          console.log('[FFmpeg] Media info parsed:', info);
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
    // Already loaded
    if (ffmpegRef.current) {
      addLog?.('info', 'Load', 'FFmpeg zaten yüklü (ffmpegRef mevcut)');
      return true;
    }
    
    // Already loading
    if (isLoading) {
      addLog?.('info', 'Load', 'FFmpeg zaten yükleniyor...');
      // Wait for existing load to complete
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
      console.log('[FFmpeg] Load timeout - showing loading message');
      addLog?.('warning', 'Load', 'FFmpeg yükleme 10 saniyeyi aştı');
    }, 10000);

    try {
      const ffmpeg = new FFmpeg();
      console.log('[FFmpeg] FFmpeg load started');
      addLog?.('info', 'Load', 'FFmpeg başlatılıyor');

      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg]', message);
      });

      updateDebugInfo?.({ coreJsLoadStatus: 'loading', wasmLoadStatus: 'loading' });
      addLog?.('info', 'Load', 'Core JS yükleniyor: /ffmpeg/ffmpeg-core.js');
      
      await ffmpeg.load({
        coreURL: '/ffmpeg/ffmpeg-core.js',
        wasmURL: '/ffmpeg/ffmpeg-core.wasm',
      });
      
      updateDebugInfo?.({ coreJsLoadStatus: 'loaded', wasmLoadStatus: 'loaded' });
      addLog?.('success', 'Load', 'Core JS yüklendi');
      addLog?.('success', 'Load', 'WASM yüklendi');
      console.log('[FFmpeg] FFmpeg load completed');

      ffmpegRef.current = ffmpeg;

      updateDebugInfo?.({ encoderValidationStatus: 'validating' });
      addLog?.('info', 'Load', 'Encoder doğrulama başlatılıyor');
      const validation = await checkEncoders(ffmpeg);
      console.log('[FFmpeg] Encoder check completed - H.264:', validation.h264, '| AAC:', validation.aac);
      
      encoderValidationRef.current = validation;
      updateDebugInfo?.({ 
        encoderValidationStatus: 'completed',
        encoderValidationResult: validation,
        ffmpegLoadStatus: 'loaded',
      });
      addLog?.('success', 'Load', `Encoder doğrulama tamamlandı: H.264=${validation.h264}, AAC=${validation.aac}`);

      if (!validation.h264) {
        console.error('[FFmpeg] H.264 encoder not found');
        addLog?.('error', 'Load', 'H.264 encoder bulunamadı');
        throw new Error('H264_NOT_FOUND');
      }

      setIsLoaded(true);
      updateProgress(0, 'idle', false);
      addLog?.('success', 'Load', 'FFmpeg hazır - başarıyla yüklendi');
      return true;
    } catch (err) {
      console.error('[FFmpeg] Load error:', err);
      const { message, stack } = normalizeError(err);
      
      addLog?.('error', 'Load', `LOAD_FAILED: ${message}`, { stack, originalError: err });
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
        errorMessage = 'FFmpeg dosyaları yüklenemedi. Lütfen internet bağlantınızı kontrol edin ve sayfayı yenileyin.';
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
      addLog?.('error', 'Load', `LOAD_FAILED: FFmpeg yüklenemedi - ${message}`);
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

  const convert = useCallback(async (
    file: File,
    quality: QualityPreset,
    mediaInfo: MediaInfo | null,
    onStageChange?: (stage: ConversionStage) => void
  ): Promise<ConversionResult> => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      const err = new Error('FFmpeg henüz yüklenmedi - ffmpegRef.current is null');
      addLog?.('error', 'Convert', `HATA: FFmpeg nesnesi mevcut değil`, { 
        stack: err.stack,
        details: 'ffmpegRef.current is null - FFmpeg load() was not called or failed'
      });
      updateDebugInfo?.({ 
        errorMessage: 'FFmpeg nesnesi mevcut değil',
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'FFMPEG_NOT_LOADED',
        message: 'FFmpeg henüz yüklenmedi.',
        technical: `ffmpegRef.current is null\n${err.stack || ''}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    const validation = encoderValidationRef.current;
    if (!validation) {
      const err = new Error('Encoder doğrulaması yapılmadı - encoderValidationRef.current is null');
      addLog?.('error', 'Convert', `HATA: Encoder doğrulaması yapılmadı`, { 
        stack: err.stack,
        details: 'encoderValidationRef.current is null - encoders were not checked'
      });
      updateDebugInfo?.({ 
        errorMessage: 'Encoder doğrulaması yapılmadı',
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'ENCODER_NOT_VALIDATED',
        message: 'Dönüştürücü hazır değil.',
        technical: `encoderValidationRef.current is null\n${err.stack || ''}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    if (!validation.h264) {
      const err = new Error('H.264 encoder mevcut değil - validation.h264 = false');
      addLog?.('error', 'Convert', `HATA: H.264 encoder mevcut değil`, { 
        stack: err.stack,
        details: { validation }
      });
      updateDebugInfo?.({ 
        errorMessage: 'H.264 encoder mevcut değil',
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'H264_ENCODER_UNAVAILABLE',
        message: 'Bu tarayıcıda gerekli H.264 dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.',
        technical: `H.264 encoder not found in FFmpeg\nvalidation.h264 = ${validation.h264}\nvalidation.aac = ${validation.aac}\n${err.stack || ''}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    // Initialize start time and clear any previous timeout
    startTimeRef.current = Date.now();
    clearProgressTimeout();
    setError(null);
    updateDebugInfo?.({ fileWriteStatus: 'idle', ffmpegExecStartTime: null, lastProgressValue: null });

    const crfMap: Record<QualityPreset, number> = {
      high: 18,
      balanced: 23,
      small: 28,
    };
    const crf = crfMap[quality];

    // Flag to track if we've received first progress event
    let hasReceivedProgress = false;

    // Step 1: Read file into memory
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
      addLog?.('error', 'Convert', `FILE_READ_FAILED: ${message}`, { stack, originalError: err });
      updateDebugInfo?.({ 
        errorMessage: `Dosya okunamadı: ${message}`, 
        errorStack: stack 
      });
      const errorObj: ConversionError = {
        code: 'FILE_READ_ERROR',
        message: 'Video dosyası okunamadı.',
        technical: `file.arrayBuffer() başarısız\n${message}\nStack: ${stack || 'yok'}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err; // Re-throw ORIGINAL error
    }

    // Step 2: Write file to FFmpeg VFS
    addLog?.('info', 'Convert', `WRITE_FILE_STARTED: ${INPUT_FILE} (${fileData.byteLength} bytes)`);
    updateDebugInfo?.({ fileWriteStatus: 'writing' });
    
    try {
      fileDataRef.current = fileData;
      await ffmpeg.writeFile(INPUT_FILE, fileData);
      updateDebugInfo?.({ fileWriteStatus: 'written' });
      addLog?.('success', 'Convert', `WRITE_FILE_SUCCESS: ${INPUT_FILE}`);
    } catch (err) {
      const { message, stack } = normalizeError(err);
      updateDebugInfo?.({ fileWriteStatus: 'error' });
      addLog?.('error', 'Convert', `WRITE_FILE_FAILED: ${message}`, { 
        stack,
        originalError: err,
        details: { fileName: INPUT_FILE, dataLength: fileData.byteLength }
      });
      updateDebugInfo?.({ 
        errorMessage: `Dosya FFmpeg VFS'ye yazılamadı: ${message}`, 
        errorStack: stack 
      });
      const errorObj: ConversionError = {
        code: 'WRITE_FILE_ERROR',
        message: 'Dosya FFmpeg VFS\'ye yazılamadı.',
        technical: `ffmpeg.writeFile("${INPUT_FILE}", ${fileData.byteLength} bytes) başarısız\n${message}\nFile: ${INPUT_FILE}\nSize: ${fileData.byteLength} bytes\nStack: ${stack || 'yok'}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err; // Re-throw ORIGINAL error with full context
    }

    // Step 3: Use provided mediaInfo (analysis already done by parent component)
    const parsedMediaInfo = mediaInfo;
    if (!parsedMediaInfo) {
      const err = new Error('Medya bilgisi bulunamadı - lütfen dosyayı tekrar seçin');
      addLog?.('error', 'Convert', `MEDIA_INFO_MISSING: ${err.message}`);
      updateDebugInfo?.({ 
        errorMessage: err.message, 
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'MEDIA_INFO_MISSING',
        message: err.message,
        technical: `mediaInfo is null - analysis was not completed before convert()`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }
    addLog?.('info', 'Convert', `Medya bilgisi kullanılıyor: ${parsedMediaInfo.resolution || 'bilinmiyor'}, sesli: ${parsedMediaInfo.hasAudio}`);

    if (parsedMediaInfo.hasAudio && !validation.aac) {
      const err = new Error('AAC encoder mevcut değil - video sesli');
      addLog?.('error', 'Convert', `AAC_NOT_FOUND: ${err.message}`, { 
        stack: err.stack,
        details: { validation }
      });
      updateDebugInfo?.({ 
        errorMessage: err.message,
        errorStack: err.stack 
      });
      const errorObj: ConversionError = {
        code: 'AAC_ENCODER_UNAVAILABLE',
        message: 'Bu videoda ses var ancak AAC dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.',
        technical: `AAC encoder not available\nvalidation.aac = ${validation.aac}\nparsedMediaInfo.hasAudio = ${parsedMediaInfo.hasAudio}\n${err.stack || ''}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    // Step 4: Execute FFmpeg
    onStageChange?.('converting');
    updateProgress(10, 'converting', false);
    addLog?.('info', 'Convert', 'Dönüştürme başlatılıyor...');

    const ffmpegArgs = [
      '-i', INPUT_FILE,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', crf.toString(),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    ];

    if (parsedMediaInfo.hasAudio) {
      ffmpegArgs.push(
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000'
      );
    } else {
      ffmpegArgs.push('-an');
    }

    ffmpegArgs.push(OUTPUT_FILE);

    console.log('[FFmpeg] Command:', ffmpegArgs.join(' '));
    console.log('[FFmpeg] Has audio:', parsedMediaInfo.hasAudio);
    addLog?.('info', 'FFmpeg', `Komut: ${ffmpegArgs.join(' ')}`);
    addLog?.('info', 'Convert', 'EXEC_STARTED...');
    updateDebugInfo?.({ ffmpegExecStartTime: Date.now() });

    // Set up progress handler
    progressHandlerRef.current = (data: { progress: number; time?: number }) => {
      const p = data.progress;
      const time = data.time;
      
      // Log raw values for debugging
      console.log('[FFmpeg] Progress raw:', { progress: p, time });
      
      if (!hasReceivedProgress) {
        hasReceivedProgress = true;
        clearProgressTimeout();
        console.log('[FFmpeg] First progress event received');
        addLog?.('success', 'Convert', `PROGRESS_RECEIVED: p=${p}, time=${time}`);
      }
      
      // Safely normalize progress value
      const normalizedProgress = normalizeProgress(p);
      
      // Skip update if progress is invalid (time value or negative)
      if (normalizedProgress < 0) {
        console.log('[FFmpeg] Progress ignored (invalid value):', p);
        return;
      }
      
      const percent = 10 + Math.round(normalizedProgress * 85);
      console.log('[FFmpeg] Progress calculated:', percent, '% (from', p, ')');
      updateProgress(percent, 'converting', true);
      updateDebugInfo?.({ lastProgressValue: percent, lastProgressRaw: p });
    };
    ffmpeg.on('progress', progressHandlerRef.current);

    // Set up progress timeout (30 seconds)
    progressTimeoutRef.current = setTimeout(() => {
      console.error('[FFmpeg] Progress timeout - no progress event received in 30 seconds');
      addLog?.('error', 'Convert', 'PROGRESS_TIMEOUT: 30 saniye içinde progress olayı alınamadı');
    }, PROGRESS_TIMEOUT_MS);

    try {
      await ffmpeg.exec(ffmpegArgs as string[]);
      console.log('[FFmpeg] ffmpeg.exec completed successfully');
      addLog?.('success', 'Convert', 'EXEC_SUCCESS: ffmpeg.exec() tamamlandı');
    } catch (err) {
      const { message, stack } = normalizeError(err);
      clearProgressTimeout();
      
      addLog?.('error', 'Convert', `EXEC_FAILED: ${message}`, { stack, originalError: err });
      updateDebugInfo?.({ 
        errorMessage: `Dönüştürme başlatılamadı: ${message}`, 
        errorStack: stack 
      });
      
      let errorMessage = 'Video dönüştürülürken bir sorun oluştu. Lütfen daha küçük bir dosyayla tekrar deneyin veya farklı bir tarayıcı kullanın.';
      let errorCode = 'CONVERSION_ERROR';
      
      if (message.includes('memory') || message.includes('Memory')) {
        errorMessage = 'Cihaz belleği yetersiz. Lütfen daha küçük bir dosya deneyin.';
        errorCode = 'MEMORY_ERROR';
      } else if (!hasReceivedProgress) {
        errorMessage = 'Video dönüştürme başlatılamadı. Bu genellikle cihaz belleğinin yetersiz olduğu anlamına gelir.';
        errorCode = 'PROGRESS_TIMEOUT';
      }

      const errorObj: ConversionError = {
        code: errorCode,
        message: errorMessage,
        technical: `ffmpeg.exec() başarısız\nKomut: ${ffmpegArgs.join(' ')}\n${message}\nhasReceivedProgress: ${hasReceivedProgress}\nStack: ${stack || 'yok'}`,
      };
      setError(errorObj);
      updateDebugInfo?.({ errorCode, errorMessage });
      onStageChange?.('error');
      throw err; // Re-throw ORIGINAL error
    }
    
    clearProgressTimeout();
    ffmpeg.off('progress', progressHandlerRef.current);
    progressHandlerRef.current = null;

    // Step 5: Read output file
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
      addLog?.('error', 'Convert', `OUTPUT_READ_FAILED: ${message}`, { stack, originalError: err });
      updateDebugInfo?.({ 
        errorMessage: `MP4 dosyası okunamadı: ${message}`, 
        errorStack: stack 
      });
      const errorObj: ConversionError = {
        code: 'OUTPUT_READ_ERROR',
        message: 'MP4 dosyası okunamadı.',
        technical: `ffmpeg.readFile("${OUTPUT_FILE}") başarısız\n${message}\nStack: ${stack || 'yok'}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err; // Re-throw ORIGINAL error
    }

    onStageChange?.('complete');
    updateProgress(100, 'complete', true);

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
    
    console.log('[FFmpeg] Conversion completed in', duration.toFixed(1), 'seconds');
    addLog?.('success', 'Convert', `CONVERSION_COMPLETE: ${duration.toFixed(1)} sn, ${blob.size} bytes`);

    // Cleanup
    clearProgressTimeout();
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
  }, [cleanupAllFiles, parseMediaInfo, updateProgress, clearProgressTimeout, addLog, updateDebugInfo, normalizeError, normalizeProgress]);

  const terminate = useCallback(() => {
    clearProgressTimeout();
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
      encoderValidationRef.current = null;
    }
    if (fileDataRef.current) {
      fileDataRef.current = null;
    }
    setProgress({ percent: 0, time: 0, stage: 'idle', hasProgress: false });
    setError(null);
  }, [clearProgressTimeout]);

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
