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
  EncoderInfo,
  ConversionCapabilities 
} from '@/types/converter';
import { getOutputFileName } from '@/lib/file-utils';

const INPUT_FILE = 'input.webm';
const OUTPUT_FILE = 'output.mp4';

interface UseFfmpegReturn {
  isLoaded: boolean;
  isLoading: boolean;
  progress: ConversionProgress;
  error: ConversionError | null;
  capabilities: ConversionCapabilities | null;
  loadFFmpeg: () => Promise<void>;
  analyzeMedia: (file: File) => Promise<MediaInfo>;
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
  const capabilitiesRef = useRef<ConversionCapabilities | null>(null);
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ConversionProgress>({
    percent: 0,
    time: 0,
    stage: 'idle',
  });
  const [error, setError] = useState<ConversionError | null>(null);
  const [capabilities, setCapabilities] = useState<ConversionCapabilities | null>(null);

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

  const checkEncoders = useCallback(async (ffmpeg: FFmpeg): Promise<EncoderInfo> => {
    const encoders: EncoderInfo = {
      h264: false,
      vp8: false,
      vp9: false,
      aac: false,
      mp3: false,
    };

    return new Promise((resolve) => {
      const logs: string[] = [];
      
      const logHandler = ({ message }: { message: string }) => {
        logs.push(message);
        
        // Check for video encoders
        if (message.includes('libx264')) encoders.h264 = true;
        if (message.includes('libvpx')) encoders.vp8 = true;
        if (message.includes('libvpx-vp9')) encoders.vp9 = true;
        
        // Check for audio encoders
        if (message.includes('aac')) encoders.aac = true;
        if (message.includes('mp3') || message.includes('libmp3lame')) encoders.mp3 = true;
      };
      
      ffmpeg.on('log', logHandler);
      
      ffmpeg.exec(['-encoders']).then(() => {
        ffmpeg.off('log', logHandler);
        
        if (process.env.NODE_ENV === 'development') {
          console.log('[FFmpeg] Encoders found:', encoders);
        }
        
        resolve(encoders);
      }).catch(() => {
        ffmpeg.off('log', logHandler);
        resolve(encoders);
      });
    });
  }, []);

  const parseMediaInfo = useCallback(async (ffmpeg: FFmpeg, file: File): Promise<MediaInfo> => {
    return new Promise((resolve) => {
      const logs: string[] = [];
      
      const logHandler = ({ message }: { message: string }) => {
        logs.push(message);
      };
      
      ffmpeg.on('log', logHandler);
      
      ffmpeg.exec(['-i', INPUT_FILE, '-f', 'null', '-']).then(() => {
        ffmpeg.off('log', logHandler);
        
        const fullLog = logs.join('\n');
        
        const info: MediaInfo = {
          fileName: file.name,
          fileSize: file.size,
          videoCodec: null,
          pixelFormat: null,
          frameRate: null,
          bitrate: null,
          duration: null,
          hasAudio: false,
          audioCodec: null,
          audioBitrate: null,
          audioSampleRate: null,
          audioChannels: null,
        };
        
        // Parse video codec
        const videoMatch = fullLog.match(/Video:\s*(\w+)/);
        if (videoMatch) {
          info.videoCodec = videoMatch[1];
        }
        
        // Parse dimensions
        const dimsMatch = fullLog.match(/(\d+)x(\d+)/);
        if (dimsMatch) {
          info.pixelFormat = `${dimsMatch[1]}x${dimsMatch[2]}`;
        }
        
        // Parse frame rate
        const fpsMatch = fullLog.match(/(\d+(?:\.\d+)?)\s*fps/);
        if (fpsMatch) {
          info.frameRate = parseFloat(fpsMatch[1]);
        }
        
        // Parse duration
        const durationMatch = fullLog.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseInt(durationMatch[3]);
          const ms = parseInt(durationMatch[4]);
          info.duration = hours * 3600 + minutes * 60 + seconds + ms / 100;
        }
        
        // Parse bitrate
        const bitrateMatch = fullLog.match(/bitrate:\s*(\d+)\s*kb/);
        if (bitrateMatch) {
          info.bitrate = parseInt(bitrateMatch[1]);
        }
        
        // Parse audio stream info
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
          
          const channelsMatch = audioMatch[0].match(/(\d+)\s*ch/);
          if (channelsMatch) {
            info.audioChannels = parseInt(channelsMatch[1]);
          }
        }
        
        if (process.env.NODE_ENV === 'development') {
          console.log('[FFmpeg] Media info:', info);
        }
        
        resolve(info);
      }).catch(() => {
        ffmpeg.off('log', logHandler);
        
        resolve({
          fileName: file.name,
          fileSize: file.size,
          videoCodec: null,
          pixelFormat: null,
          frameRate: null,
          bitrate: null,
          duration: null,
          hasAudio: false,
          audioCodec: null,
          audioBitrate: null,
          audioSampleRate: null,
          audioChannels: null,
        });
      });
    });
  }, []);

  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current || isLoading) return;

    setIsLoading(true);
    setError(null);
    updateProgress(0, 'loading');

    try {
      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => {
        if (process.env.NODE_ENV === 'development') {
          console.log('[FFmpeg]', message);
        }
      });

      await ffmpeg.load({
        coreURL: '/ffmpeg/ffmpeg-core.js',
        wasmURL: '/ffmpeg/ffmpeg-core.wasm',
      });

      ffmpegRef.current = ffmpeg;

      const encoders = await checkEncoders(ffmpeg);
      
      let videoCodec: 'libx264' | 'libvpx' | 'libvpx-vp9' = 'libx264';
      let audioCodec: 'aac' | 'mp3' = 'aac';
      
      if (!encoders.h264) {
        if (encoders.vp9) {
          videoCodec = 'libvpx-vp9';
          console.log('[FFmpeg] libx264 not available, using libvpx-vp9');
        } else if (encoders.vp8) {
          videoCodec = 'libvpx';
          console.log('[FFmpeg] libx264 not available, using libvpx');
        } else {
          throw new Error('No supported video encoder found');
        }
      }
      
      if (!encoders.aac && encoders.mp3) {
        audioCodec = 'mp3';
        console.log('[FFmpeg] AAC not available, using MP3');
      }

      const caps = { encoders, videoCodec, audioCodec };
      capabilitiesRef.current = caps;
      setCapabilities(caps);

      setIsLoaded(true);
      updateProgress(0, 'idle');
    } catch (err) {
      console.error('FFmpeg load error:', err);
      const errorObj: ConversionError = {
        code: 'FFMPEG_LOAD_ERROR',
        message: 'Dönüştürücü yüklenemedi. Tarayıcınız WebAssembly desteklemiyor olabilir.',
      };
      if (err instanceof Error) {
        errorObj.technical = err.message;
      }
      setError(errorObj);
      updateProgress(0, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, updateProgress, checkEncoders]);

  const analyzeMedia = useCallback(async (file: File): Promise<MediaInfo> => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      throw new Error('FFmpeg henüz yüklenmedi');
    }

    const fileData = new Uint8Array(await file.arrayBuffer());
    await ffmpeg.writeFile(INPUT_FILE, fileData);

    const mediaInfo = await parseMediaInfo(ffmpeg, file);

    try {
      await ffmpeg.deleteFile(INPUT_FILE);
    } catch {
      // Ignore cleanup errors
    }

    return mediaInfo;
  }, [parseMediaInfo]);

  const convert = useCallback(async (
    file: File,
    quality: QualityPreset,
    onStageChange?: (stage: ConversionStage) => void
  ): Promise<ConversionResult> => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      throw new Error('FFmpeg henüz yüklenmedi');
    }

    const caps = capabilitiesRef.current;
    if (!caps) {
      throw new Error('Dönüştürücü hazır değil');
    }

    startTimeRef.current = Date.now();
    setError(null);

    const crfMap: Record<QualityPreset, number> = {
      high: 18,
      balanced: 23,
      small: 28,
    };
    const crf = crfMap[quality];

    const isH264 = caps.videoCodec === 'libx264';
    const outputExt = isH264 ? 'mp4' : 'webm';

    try {
      onStageChange?.('reading');
      updateProgress(0, 'reading');

      fileDataRef.current = new Uint8Array(await file.arrayBuffer());
      await ffmpeg.writeFile(INPUT_FILE, fileDataRef.current);
      
      onStageChange?.('converting');
      updateProgress(5, 'converting');

      const mediaInfo = await parseMediaInfo(ffmpeg, file);

      onStageChange?.('finalizing');
      updateProgress(10, 'finalizing');

      const ffmpegArgs: (string | number)[] = ['-i', INPUT_FILE];

      if (caps.videoCodec === 'libx264') {
        ffmpegArgs.push(
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', crf.toString(),
          '-pix_fmt', 'yuv420p'
        );
        if (outputExt === 'mp4') {
          ffmpegArgs.push('-movflags', '+faststart');
        }
      } else if (caps.videoCodec === 'libvpx-vp9') {
        ffmpegArgs.push(
          '-c:v', 'libvpx-vp9',
          '-crf', crf.toString(),
          '-b:v', '0'
        );
      } else {
        ffmpegArgs.push(
          '-c:v', 'libvpx',
          '-crf', crf.toString(),
          '-b:v', '1M'
        );
      }

      if (mediaInfo.hasAudio) {
        if (caps.audioCodec === 'aac') {
          ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000');
        } else {
          ffmpegArgs.push('-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '48000');
        }
      } else {
        ffmpegArgs.push('-an');
      }

      ffmpegArgs.push(OUTPUT_FILE);

      if (process.env.NODE_ENV === 'development') {
        console.log('[FFmpeg] Command:', ffmpegArgs.join(' '));
      }

      const progressHandler = ({ progress: p }: { progress: number }) => {
        const percent = 10 + Math.round(p * 85);
        updateProgress(percent, 'converting');
      };
      
      ffmpeg.on('progress', progressHandler);

      await ffmpeg.exec(ffmpegArgs as string[]);
      
      ffmpeg.off('progress', progressHandler);

      updateProgress(95, 'finalizing');
      const outputData = await ffmpeg.readFile(OUTPUT_FILE);

      updateProgress(100, 'complete');
      onStageChange?.('complete');

      await cleanupFiles(ffmpeg);

      if (fileDataRef.current) {
        fileDataRef.current = null;
      }

      let uint8Output: Uint8Array;
      if (outputData instanceof Uint8Array) {
        uint8Output = new Uint8Array(outputData);
      } else if (typeof outputData === 'string') {
        const encoder = new TextEncoder();
        uint8Output = encoder.encode(outputData);
      } else {
        uint8Output = new Uint8Array(outputData as ArrayBuffer);
      }
      
      const mimeType = isH264 ? 'video/mp4' : 'video/webm';
      const blob = new Blob([uint8Output.buffer as ArrayBuffer], { type: mimeType });
      const duration = (Date.now() - startTimeRef.current) / 1000;

      return {
        blob,
        fileName: getOutputFileName(file.name).replace(/\.\w+$/, `.${outputExt}`),
        fileSize: blob.size,
        duration,
      };
    } catch (err) {
      console.error('Conversion error:', err);
      
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
      } else if (errorText.includes('Invalid') || errorText.includes('invalid') || errorText.includes('no supported encoder')) {
        errorMessage = 'Video codec desteklenmiyor veya dosya bozuk.';
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
  }, [cleanupFiles, parseMediaInfo, updateProgress]);

  const terminate = useCallback(() => {
    if (ffmpegRef.current) {
      ffmpegRef.current.terminate();
      ffmpegRef.current = null;
      setIsLoaded(false);
      capabilitiesRef.current = null;
      setCapabilities(null);
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
    capabilities,
    loadFFmpeg,
    analyzeMedia,
    convert,
    terminate,
  };
}
