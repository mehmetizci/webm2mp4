// FFmpeg Converter Adapter
// Wraps the existing FFmpeg functionality for the unified converter interface

import type {
  VideoConverter,
  ConvertOptions,
  ConversionResult,
  ConverterSupport,
} from './types';
import type { ConversionStage } from '@/types/converter';
import { checkFFmpegSupport } from './webCodecsSupport';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { getOutputFileName } from '@/lib/file-utils';

// FFmpeg URLs
const BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

interface FFmpegState {
  ffmpeg: FFmpeg | null;
  loaded: boolean;
  loading: boolean;
}

const state: FFmpegState = {
  ffmpeg: null,
  loaded: false,
  loading: false,
};

// Default conversion settings
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 1280;
const DEFAULT_BITRATE = 650_000;
const DEFAULT_FRAMERATE = 30;

export class FFmpegConverter implements VideoConverter {
  private abortController: AbortController | null = null;

  async checkSupport(): Promise<ConverterSupport> {
    return checkFFmpegSupport();
  }

  async loadFFmpeg(): Promise<boolean> {
    if (state.loaded) return true;
    if (state.loading) return false;

    state.loading = true;

    try {
      const ffmpeg = new FFmpeg();
      state.ffmpeg = ffmpeg;

      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg]', message);
      });

      await ffmpeg.load({
        coreURL: await toBlobURL(`${BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
      });

      state.loaded = true;
      state.loading = false;
      return true;
    } catch (error) {
      console.error('[FFmpeg] Load failed:', error);
      state.loading = false;
      state.loaded = false;
      return false;
    }
  }

  async convert(options: ConvertOptions): Promise<ConversionResult> {
    const startTime = Date.now();
    this.abortController = new AbortController();

    const {
      file,
      width = DEFAULT_WIDTH,
      height = DEFAULT_HEIGHT,
      bitrate = DEFAULT_BITRATE,
      framerate = DEFAULT_FRAMERATE,
      onProgress,
      signal,
    } = options;

    // Report initial progress
    const reportProgress = (stage: ConversionStage, percent: number | null = null, encodedSeconds = 0) => {
      if (onProgress) {
        onProgress({
          percent: percent ?? 0,
          time: encodedSeconds,
          stage,
          hasProgress: percent !== null,
          encodedTime: encodedSeconds,
          totalDuration: null,
        });
      }
    };

    // Check abort signal
    if (signal?.aborted) {
      throw new Error('Conversion aborted');
    }

    reportProgress('reading');

    // Load FFmpeg if not loaded
    if (!state.loaded) {
      const loaded = await this.loadFFmpeg();
      if (!loaded) {
        throw new Error('FFmpeg failed to load');
      }
    }

    const ffmpeg = state.ffmpeg;
    if (!ffmpeg) {
      throw new Error('FFmpeg not initialized');
    }

    reportProgress('analyzing');

    // Write input file
    const inputData = await fetchFile(file);
    await ffmpeg.writeFile('input.webm', inputData);

    // Build FFmpeg arguments for H.264 encoding
    const crf = 28; // Constant Rate Factor for quality
    const maxrate = Math.floor(bitrate / 1000); // Convert to kbps

    const ffmpegArgs = [
      '-i', 'input.webm',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', crf.toString(),
      '-maxrate', `${maxrate}k`,
      '-bufsize', `${maxrate * 2}k`,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      '-r', framerate.toString(),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      'output.mp4',
    ];

    // Set up progress tracking
    let lastEncodedTime = 0;
    let totalDuration = 0;
    let lastProgressUpdate = Date.now();

    ffmpeg.on('progress', ({ progress, time }) => {
      // Use FFmpeg's progress for timing
      if (time > 0 && totalDuration === 0) {
        // Estimate total duration from input file
        totalDuration = time;
      }

      const currentTime = Date.now();
      if (currentTime - lastProgressUpdate > 100) { // Throttle updates
        lastProgressUpdate = currentTime;

        if (onProgress) {
          const percent = progress > 0 && progress <= 1
            ? Math.min(99, Math.floor(progress * 100))
            : null;

          onProgress({
            percent: percent ?? 0,
            time: time / 1_000_000, // FFmpeg time is in microseconds
            stage: 'converting',
            hasProgress: percent !== null,
            encodedTime: time / 1_000_000,
            totalDuration: totalDuration > 0 ? totalDuration / 1_000_000 : null,
          });
        }
      }
    });

    // Check abort before execution
    if (signal?.aborted || this.abortController.signal.aborted) {
      await this.cleanup();
      throw new Error('Conversion aborted');
    }

    reportProgress('converting');

    // Execute FFmpeg
    await ffmpeg.exec(ffmpegArgs);

    // Check abort after execution
    if (signal?.aborted || this.abortController.signal.aborted) {
      await this.cleanup();
      throw new Error('Conversion aborted');
    }

    reportProgress('finalizing', 99);

    // Read output file
    const outputData = await ffmpeg.readFile('output.mp4');
    // FFmpeg readFile returns Uint8Array for binary files
    const blob = new Blob([outputData as BlobPart], { type: 'video/mp4' });

    // Calculate stats
    const encodeTime = (Date.now() - startTime) / 1000;
    const compressionRatio = Math.round(((file.size - blob.size) / file.size) * 100);
    const videoBitrate = encodeTime > 0 ? (blob.size * 8 / encodeTime / 1000) : null;

    reportProgress('complete', 100);

    return {
      blob,
      filename: getOutputFileName(file.name),
      fileSize: blob.size,
      inputSize: file.size,
      duration: encodeTime,
      videoBitrate,
      audioBitrate: 128,
      compressionRatio,
      encodeTime,
      averageSpeed: null,
      engine: 'ffmpeg-wasm',
      hasAudio: true,
    };
  }

  async cleanup(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;

    if (state.ffmpeg) {
      try {
        await state.ffmpeg.deleteFile('input.webm');
        await state.ffmpeg.deleteFile('output.mp4');
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  abort(): void {
    this.abortController?.abort();
  }
}

// Singleton instance
let ffmpegInstance: FFmpegConverter | null = null;

export function getFFmpegConverter(): FFmpegConverter {
  if (!ffmpegInstance) {
    ffmpegInstance = new FFmpegConverter();
  }
  return ffmpegInstance;
}
