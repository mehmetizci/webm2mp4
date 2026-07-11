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
  loadFFmpeg: () => Promise<void>;
  analyzeMedia: (file: File) => Promise<MediaInfo>;
  convert: (
    file: File,
    quality: QualityPreset,
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

  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current || isLoading) return;

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
      addLog?.('success', 'Load', 'FFmpeg hazır');
    } catch (err) {
      console.error('[FFmpeg] Load error:', err);
      const error = err instanceof Error ? err : new Error(String(err));
      const errorText = error.message;
      
      addLog?.('error', 'Load', `Hata: ${errorText}`, { stack: error.stack });
      updateDebugInfo?.({ 
        ffmpegLoadStatus: 'error',
        errorCode: 'FFMPEG_LOAD_ERROR',
        errorMessage: errorText,
        errorStack: error.stack,
      });
      
      let errorMessage = 'Dönüştürücü yüklenemedi.';
      
      if (errorText === 'H264_NOT_FOUND') {
        errorMessage = 'Bu tarayıcıda gerekli H.264 dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.';
      } else if (errorText.includes('fetch') || errorText.includes('network') || errorText.includes('Failed to')) {
        errorMessage = 'FFmpeg dosyaları yüklenemedi. Lütfen internet bağlantınızı kontrol edin ve sayfayı yenileyin.';
      } else {
        errorMessage = 'Dönüştürücü yüklenemedi. Tarayıcınız WebAssembly desteklemiyor olabilir.';
      }
      
      const errorObj: ConversionError = {
        code: 'FFMPEG_LOAD_ERROR',
        message: errorMessage,
        technical: errorText,
      };
      setError(errorObj);
      updateProgress(0, 'error', false);
    } finally {
      clearTimeout(loadTimeout);
      setIsLoading(false);
    }
  }, [isLoading, updateProgress, checkEncoders, addLog, updateDebugInfo]);

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
    onStageChange?: (stage: ConversionStage) => void
  ): Promise<ConversionResult> => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      addLog?.('error', 'Convert', 'FFmpeg henüz yüklenmedi');
      throw new Error('FFmpeg henüz yüklenmedi');
    }

    const validation = encoderValidationRef.current;
    if (!validation) {
      addLog?.('error', 'Convert', 'Dönüştürücü hazır değil');
      throw new Error('Dönüştürücü hazır değil');
    }

    if (!validation.h264) {
      addLog?.('error', 'Convert', 'H.264 encoder mevcut değil');
      const errorObj: ConversionError = {
        code: 'H264_ENCODER_UNAVAILABLE',
        message: 'Bu tarayıcıda gerekli H.264 dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.',
      };
      setError(errorObj);
      onStageChange?.('error');
      throw new Error('H264_NOT_FOUND');
    }

    // Initialize start time and clear any previous timeout
    startTimeRef.current = Date.now();
    clearProgressTimeout();
    setError(null);

    const crfMap: Record<QualityPreset, number> = {
      high: 18,
      balanced: 23,
      small: 28,
    };
    const crf = crfMap[quality];

    // Flag to track if we've received first progress event
    let hasReceivedProgress = false;

    try {
      onStageChange?.('reading');
      updateProgress(0, 'reading', false);
      addLog?.('info', 'Convert', 'Dosya okunuyor');

      console.log('[FFmpeg] ffmpeg.exec started - reading file');
      
      fileDataRef.current = new Uint8Array(await file.arrayBuffer());
      addLog?.('info', 'Convert', `Dosya belleğe yüklendi: ${fileDataRef.current.byteLength} bytes`);
      
      updateDebugInfo?.({ fileWriteStatus: 'writing' });
      addLog?.('info', 'Convert', 'Dosya FFmpeg VFS\'e yazılıyor...');
      await ffmpeg.writeFile(INPUT_FILE, fileDataRef.current);
      updateDebugInfo?.({ fileWriteStatus: 'written' });
      addLog?.('success', 'Convert', 'Dosya FFmpeg VFS\'e yazıldı');
      
      onStageChange?.('analyzing');
      updateProgress(5, 'analyzing', false);
      addLog?.('info', 'Convert', 'Medya analizi başlatılıyor');

      const mediaInfo = await parseMediaInfo(ffmpeg, file, INPUT_FILE);
      addLog?.('info', 'Convert', `Medya analiz edildi: ${mediaInfo.resolution || 'bilinmiyor'}, sesli: ${mediaInfo.hasAudio}`);

      if (mediaInfo.hasAudio && !validation.aac) {
        addLog?.('error', 'Convert', 'Video sesli ancak AAC encoder mevcut değil');
        const errorObj: ConversionError = {
          code: 'AAC_ENCODER_UNAVAILABLE',
          message: 'Bu videoda ses var ancak AAC dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.',
        };
        setError(errorObj);
        onStageChange?.('error');
        throw new Error('AAC_NOT_FOUND');
      }

      onStageChange?.('converting');
      updateProgress(10, 'converting', false);
      addLog?.('info', 'Convert', 'Dönüştürme başlatılıyor');

      const ffmpegArgs = [
        '-i', INPUT_FILE,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', crf.toString(),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
      ];

      if (mediaInfo.hasAudio) {
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
      console.log('[FFmpeg] Has audio:', mediaInfo.hasAudio);
      console.log('[FFmpeg] ffmpeg.exec starting with args...');
      addLog?.('info', 'FFmpeg', `Komut: ${ffmpegArgs.join(' ')}`);
      addLog?.('info', 'Convert', 'ffmpeg.exec() başlatılıyor...');
      updateDebugInfo?.({ ffmpegExecStartTime: Date.now() });

      // Set up progress handler
      progressHandlerRef.current = ({ progress: p }) => {
        if (!hasReceivedProgress) {
          hasReceivedProgress = true;
          clearProgressTimeout();
          console.log('[FFmpeg] First progress event received');
          addLog?.('success', 'Convert', 'İlk progress olayı alındı');
        }
        const percent = 10 + Math.round(p * 85);
        updateProgress(percent, 'converting', true);
        updateDebugInfo?.({ lastProgressValue: percent });
      };
      ffmpeg.on('progress', progressHandlerRef.current);

      // Set up progress timeout (30 seconds)
      progressTimeoutRef.current = setTimeout(() => {
        console.error('[FFmpeg] Progress timeout - no progress event received in 30 seconds');
        addLog?.('error', 'Convert', '30 saniye içinde progress olayı alınamadı - timeout');
      }, PROGRESS_TIMEOUT_MS);

      await ffmpeg.exec(ffmpegArgs as string[]);
      console.log('[FFmpeg] ffmpeg.exec completed successfully');
      addLog?.('success', 'Convert', 'ffmpeg.exec() tamamlandı');
      
      clearProgressTimeout();
      ffmpeg.off('progress', progressHandlerRef.current);
      progressHandlerRef.current = null;

      onStageChange?.('finalizing');
      updateProgress(95, 'finalizing', true);
      addLog?.('info', 'Convert', 'Çıktı dosyası okunuyor');
      
      const outputData = await ffmpeg.readFile(OUTPUT_FILE);
      addLog?.('info', 'Convert', `Çıktı dosyası okundu: ${outputData instanceof Uint8Array ? outputData.byteLength : 'bilinmiyor'} bytes`);

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
      addLog?.('success', 'Convert', `Dönüştürme tamamlandı: ${duration.toFixed(1)} saniye, ${blob.size} bytes`);

      return {
        blob,
        fileName: getOutputFileName(file.name),
        fileSize: blob.size,
        duration,
      };
    } catch (err) {
      console.error('[FFmpeg] Conversion error:', err);
      
      clearProgressTimeout();
      
      const error = err instanceof Error ? err : new Error(String(err));
      const errorText = error.message;
      
      addLog?.('error', 'Convert', `HATA: ${errorText}`, { stack: error.stack });
      updateDebugInfo?.({
        errorCode: 'CONVERSION_ERROR',
        errorMessage: errorText,
        errorStack: error.stack,
      });
      
      let errorMessage = 'Video dönüştürülürken bir sorun oluştu. Lütfen daha küçük bir dosyayla tekrar deneyin veya farklı bir tarayıcı kullanın.';
      let errorCode = 'CONVERSION_ERROR';
      
      if (errorText === 'H264_NOT_FOUND') {
        errorMessage = 'Bu tarayıcıda gerekli H.264 dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.';
        errorCode = 'H264_ENCODER_UNAVAILABLE';
      } else if (errorText === 'AAC_NOT_FOUND') {
        errorMessage = 'Bu videoda ses var ancak AAC dönüştürücü yüklenemedi. Lütfen sayfayı yenileyerek tekrar deneyin.';
        errorCode = 'AAC_ENCODER_UNAVAILABLE';
      } else if (errorText.includes('memory') || errorText.includes('Memory')) {
        errorMessage = 'Cihaz belleği yetersiz. Lütfen daha küçük bir dosya deneyin.';
        errorCode = 'MEMORY_ERROR';
      } else if (!hasReceivedProgress) {
        // If we never received any progress, it might be a timeout or FFmpeg crash
        errorMessage = 'Video dönüştürme başlatılamadı. Bu genellikle cihaz belleğinin yetersiz olduğu anlamına gelir.';
        errorCode = 'PROGRESS_TIMEOUT';
      }

      const errorObj: ConversionError = {
        code: errorCode,
        message: errorMessage,
        technical: errorText,
      };
      setError(errorObj);
      updateDebugInfo?.({ errorCode, errorMessage });

      onStageChange?.('error');
      throw err;
    } finally {
      clearProgressTimeout();
      if (progressHandlerRef.current && ffmpeg) {
        ffmpeg.off('progress', progressHandlerRef.current);
        progressHandlerRef.current = null;
      }
      
      await cleanupAllFiles(ffmpeg);
      
      if (fileDataRef.current) {
        fileDataRef.current = null;
      }
    }
  }, [cleanupAllFiles, parseMediaInfo, updateProgress, clearProgressTimeout, addLog, updateDebugInfo]);

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
