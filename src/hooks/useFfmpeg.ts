'use client';

import { useCallback, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { 
  ConversionProgress, 
  ConversionResult, 
  ConversionError,
  QualityPreset,
  ConversionStage 
} from '@/types/converter';
import { getOutputFileName } from '@/lib/file-utils';

const INPUT_FILE = 'input.webm';
const OUTPUT_FILE = 'output.mp4';

interface UseFfmpegReturn {
  isLoaded: boolean;
  isLoading: boolean;
  progress: ConversionProgress;
  error: ConversionError | null;
  loadFFmpeg: () => Promise<void>;
  convert: (
    file: File,
    quality: QualityPreset,
    onStageChange?: (stage: ConversionStage) => void
  ) => Promise<ConversionResult>;
  terminate: () => void;
}

export function useFfmpeg(): UseFfmpegReturn {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fileDataRef = useRef<Uint8Array | null>(null);
  const progressEventRef = useRef<((progress: { progress: number }) => void) | null>(null);
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ConversionProgress>({
    percent: 0,
    time: 0,
    stage: 'idle',
  });
  const [error, setError] = useState<ConversionError | null>(null);
  
  const startTimeRef = useRef<number>(0);

  const updateProgress = useCallback((percent: number, stage: ConversionStage) => {
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    setProgress({
      percent: Math.min(Math.max(percent, 0), 100),
      time: elapsed,
      stage,
    });
  }, []);

  const cleanupFiles = useCallback(async (ffmpeg: FFmpeg) => {
    const files = [INPUT_FILE, OUTPUT_FILE];
    for (const file of files) {
      try {
        await ffmpeg.deleteFile(file);
      } catch {
        // File might not exist, ignore
      }
    }
  }, []);

  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current || isLoading) return;

    setIsLoading(true);
    setError(null);
    updateProgress(0, 'loading');

    try {
      const ffmpeg = new FFmpeg();

      progressEventRef.current = ({ progress: p }) => {
        // FFmpeg progress: 0-1 range
        updateProgress(Math.round(p * 100), 'converting');
      };

      ffmpeg.on('progress', progressEventRef.current);

      ffmpeg.on('log', ({ message }) => {
        // Only log in development
        if (process.env.NODE_ENV === 'development') {
          console.log('[FFmpeg]', message);
        }
      });

      // Load from local public folder
      await ffmpeg.load({
        coreURL: '/ffmpeg/ffmpeg-core.js',
        wasmURL: '/ffmpeg/ffmpeg-core.wasm',
      });

      ffmpegRef.current = ffmpeg;
      setIsLoaded(true);
      updateProgress(0, 'idle');
    } catch (err) {
      console.error('FFmpeg load error:', err);
      const errorObj: ConversionError = {
        code: 'FFMPEG_LOAD_ERROR',
        message: 'Dönüştürücü yüklenemedi. Lütfen sayfayı yenileyip tekrar deneyin.',
      };
      if (err instanceof Error) {
        errorObj.technical = err.message;
      }
      setError(errorObj);
      updateProgress(0, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, updateProgress]);

  const checkAudioTrack = useCallback(async (ffmpeg: FFmpeg): Promise<boolean> => {
    return new Promise((resolve) => {
      let hasAudio = false;
      let resolved = false;
      
      const logHandler = ({ message }: { message: string }) => {
        if (message.includes('Audio:') && !resolved) {
          hasAudio = true;
          resolved = true;
          ffmpeg.off('log', logHandler);
          resolve(true);
        }
      };
      
      ffmpeg.on('log', logHandler);
      
      // Run a quick probe to check for audio
      ffmpeg.exec(['-i', INPUT_FILE, '-f', 'null', '-']).then(() => {
        if (!resolved) {
          resolved = true;
          resolve(hasAudio);
        }
      }).catch(() => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });
    });
  }, []);

  const convert = useCallback(async (
    file: File,
    quality: QualityPreset,
    onStageChange?: (stage: ConversionStage) => void
  ): Promise<ConversionResult> => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      throw new Error('FFmpeg henüz yüklenmedi');
    }

    startTimeRef.current = Date.now();
    setError(null);

    const crfMap: Record<QualityPreset, number> = {
      high: 18,
      balanced: 23,
      small: 28,
    };
    const crf = crfMap[quality];

    try {
      // Stage 1: Reading file
      onStageChange?.('reading');
      updateProgress(0, 'reading');

      // Read file as Uint8Array directly - memory efficient
      fileDataRef.current = new Uint8Array(await file.arrayBuffer());
      await ffmpeg.writeFile(INPUT_FILE, fileDataRef.current);
      
      // Stage 2: Converting
      onStageChange?.('converting');
      updateProgress(5, 'converting');

      // Check for audio track
      const hasAudio = await checkAudioTrack(ffmpeg);

      // Stage 3: Finalizing
      onStageChange?.('finalizing');
      updateProgress(10, 'finalizing');

      // FFmpeg command for H.264 + AAC MP4 with maximum compatibility
      const ffmpegArgs = [
        '-i', INPUT_FILE,
        // Video: H.264 codec
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', crf.toString(),
        '-pix_fmt', 'yuv420p',
        // MP4 optimization for streaming/playback
        '-movflags', '+faststart',
        // Audio: AAC codec
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000'] : ['-an']),
        OUTPUT_FILE,
      ];

      if (process.env.NODE_ENV === 'development') {
        console.log('[FFmpeg] Command:', ffmpegArgs.join(' '));
      }

      // Execute conversion with progress tracking
      await ffmpeg.exec(ffmpegArgs);

      // Read output file
      updateProgress(95, 'finalizing');
      const outputData = await ffmpeg.readFile(OUTPUT_FILE);

      // Complete
      updateProgress(100, 'complete');
      onStageChange?.('complete');

      // Cleanup FFmpeg virtual filesystem
      await cleanupFiles(ffmpeg);

      // Clear file data reference for GC
      if (fileDataRef.current) {
        fileDataRef.current = null;
      }

      // Create blob from output - FFmpeg readFile returns Uint8Array for binary files
      let uint8Output: Uint8Array;
      if (outputData instanceof Uint8Array) {
        // Copy the buffer to avoid SharedArrayBuffer issues
        uint8Output = new Uint8Array(outputData);
      } else if (typeof outputData === 'string') {
        // Should not happen for video files, but handle gracefully
        const encoder = new TextEncoder();
        uint8Output = encoder.encode(outputData);
      } else {
        uint8Output = new Uint8Array(outputData as ArrayBuffer);
      }
      
      const blob = new Blob([uint8Output.buffer as ArrayBuffer], { type: 'video/mp4' });
      const duration = (Date.now() - startTimeRef.current) / 1000;

      return {
        blob,
        fileName: getOutputFileName(file.name),
        fileSize: blob.size,
        duration,
      };
    } catch (err) {
      console.error('Conversion error:', err);
      
      // Cleanup on error
      try {
        await cleanupFiles(ffmpeg);
      } catch {
        // Ignore cleanup errors
      }
      
      if (fileDataRef.current) {
        fileDataRef.current = null;
      }

      let errorMessage = 'Video dönüştürülürken bir sorun oluştu. Lütfen daha küçük bir dosyayla tekrar deneyin veya farklı bir tarayıcı kullanın.';
      let errorCode = 'CONVERSION_ERROR';
      
      const errorText = err instanceof Error ? err.message : String(err);
      
      if (errorText.includes('memory') || errorText.includes('Memory')) {
        errorMessage = 'Cihaz belleği yetersiz. Lütfen daha küçük bir dosya deneyin.';
        errorCode = 'MEMORY_ERROR';
      } else if (errorText.includes('Invalid') || errorText.includes('invalid')) {
        errorMessage = 'Video dosyası bozuk veya desteklenmeyen format.';
        errorCode = 'INVALID_FILE';
      }

      const errorObj: ConversionError = {
        code: errorCode,
        message: errorMessage,
        technical: errorText,
      };
      
      setError(errorObj);
      onStageChange?.('error');
      
      throw err;
    }
  }, [checkAudioTrack, cleanupFiles, updateProgress]);

  const terminate = useCallback(() => {
    if (ffmpegRef.current) {
      ffmpegRef.current.terminate();
      ffmpegRef.current = null;
      setIsLoaded(false);
    }
    if (fileDataRef.current) {
      fileDataRef.current = null;
    }
    setProgress({ percent: 0, time: 0, stage: 'idle' });
    setError(null);
  }, []);

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
