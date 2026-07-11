'use client';

import { useCallback, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { 
  ConversionProgress, 
  ConversionResult, 
  ConversionError,
  QualityPreset,
  ConversionStage 
} from '@/types/converter';
import { getOutputFileName } from '@/lib/file-utils';

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
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ConversionProgress>({
    percent: 0,
    time: 0,
    stage: 'idle',
  });
  const [error, setError] = useState<ConversionError | null>(null);
  const startTimeRef = useRef<number>(0);

  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current || isLoading) return;

    setIsLoading(true);
    setProgress({ percent: 0, time: 0, stage: 'loading' });

    try {
      const ffmpeg = new FFmpeg();
      
      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg]', message);
      });

      ffmpeg.on('progress', ({ progress: p }) => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        setProgress(prev => ({
          ...prev,
          percent: Math.min(p * 100, 99),
          time: elapsed,
        }));
      });

      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

      await ffmpeg.load({
        coreURL: `${baseURL}/ffmpeg-core.js`,
        wasmURL: `${baseURL}/ffmpeg-core.wasm`,
      });

      ffmpegRef.current = ffmpeg;
      setIsLoaded(true);
      setProgress({ percent: 0, time: 0, stage: 'idle' });
    } catch (err) {
      console.error('FFmpeg load error:', err);
      setError({
        code: 'FFMPEG_LOAD_ERROR',
        message: 'Dönüştürücü yüklenemedi. Lütfen sayfayı yenileyip tekrar deneyin.',
        technical: err instanceof Error ? err.message : 'Bilinmeyen hata',
      });
    } finally {
      setIsLoading(false);
    }
  }, [isLoading]);

  const convert = useCallback(async (
    file: File,
    quality: QualityPreset,
    onStageChange?: (stage: ConversionStage) => void
  ): Promise<ConversionResult> => {
    if (!ffmpegRef.current) {
      throw new Error('FFmpeg henüz yüklenmedi');
    }

    startTimeRef.current = Date.now();
    setError(null);

    const inputFileName = 'input.webm';
    const outputFileName = 'output.mp4';

    try {
      onStageChange?.('reading');
      setProgress({ percent: 0, time: 0, stage: 'reading' });

      const fileData = await fetchFile(file);
      
      onStageChange?.('converting');
      setProgress({ percent: 10, time: 0, stage: 'converting' });

      await ffmpegRef.current.writeFile(inputFileName, fileData);

      const crfMap: Record<QualityPreset, number> = {
        high: 18,
        balanced: 23,
        small: 28,
      };

      const crf = crfMap[quality];

      onStageChange?.('finalizing');
      setProgress({ percent: 50, time: 0, stage: 'finalizing' });

      let hasAudio = false;
      try {
        await ffmpegRef.current.exec(['-i', inputFileName, '-f', 'null', '-']);
      } catch {
        hasAudio = false;
      }

      const args = hasAudio
        ? [
            '-i', inputFileName,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', crf.toString(),
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '48000',
            outputFileName,
          ]
        : [
            '-i', inputFileName,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', crf.toString(),
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-an',
            outputFileName,
          ];

      await ffmpegRef.current.exec(args);

      setProgress({ percent: 100, time: (Date.now() - startTimeRef.current) / 1000, stage: 'complete' });
      onStageChange?.('complete');

      const data = await ffmpegRef.current.readFile(outputFileName);

      await ffmpegRef.current.deleteFile(inputFileName);
      await ffmpegRef.current.deleteFile(outputFileName);

      const uint8Data = data instanceof Uint8Array ? new Uint8Array(data.buffer.slice(0)) : new Uint8Array(data as unknown as ArrayBuffer);
      const blob = new Blob([uint8Data.buffer as ArrayBuffer], { type: 'video/mp4' });
      const duration = (Date.now() - startTimeRef.current) / 1000;

      return {
        blob,
        fileName: getOutputFileName(file.name),
        fileSize: blob.size,
        duration,
      };
    } catch (err) {
      console.error('Conversion error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Bilinmeyen hata';
      
      setError({
        code: 'CONVERSION_ERROR',
        message: 'Video dönüştürülürken bir sorun oluştu. Lütfen daha küçük bir dosyayla tekrar deneyin veya farklı bir tarayıcı kullanın.',
        technical: errorMessage,
      });
      onStageChange?.('error');
      
      throw err;
    }
  }, []);

  const terminate = useCallback(() => {
    if (ffmpegRef.current) {
      ffmpegRef.current.terminate();
      ffmpegRef.current = null;
      setIsLoaded(false);
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
