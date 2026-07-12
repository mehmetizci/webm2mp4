// Production WebCodecs Video Converter using Mediabunny
// True WebM → MP4 conversion without FFmpeg
// Architecture: Mediabunny (demux/mux) + WebCodecs (codec via Mediabunny)

import type {
  VideoConverter,
  ConvertOptions,
  ConversionResult,
  ConverterSupport,
} from './types';
import { checkWebCodecsSupport } from './webCodecsSupport';
import { getOutputFileName } from '@/lib/file-utils';

// Mediabunny imports
import {
  Conversion,
  WEBM,
  Mp4OutputFormat,
  BufferTarget,
  canEncodeVideo,
  canEncodeAudio,
  QUALITY_HIGH,
} from 'mediabunny';

// Constants
const DEFAULT_VIDEO_BITRATE = 2_000_000;
const DEFAULT_FRAMERATE = 30;
const SPEED_EMA_ALPHA = 0.3; // EMA smoothing factor

export interface WebCodecsConverterOptions {
  videoBitrate?: number;
  framerate?: number;
  preferHardware?: boolean;
}

export interface WebCodecsProgress {
  stage: string;
  percent: number;
  processedSeconds: number;
  totalSeconds: number;
  speed: number;
  estimatedRemaining: number;
}

export interface WebCodecsDebugInfo {
  inputFormat: string | null;
  inputVideoCodec: string | null;
  inputAudioCodec: string | null;
  outputFormat: string;
  outputVideoCodec: string;
  outputAudioCodec: string;
  hardwareAcceleration: string;
  encodedVideoFrames: number;
  encodedAudioSamples: number;
  conversionApiUsed: boolean;
  error: string | null;
}

export class WebCodecsConverter implements VideoConverter {
  private abortController: AbortController | null = null;
  private conversion: Conversion | null = null;
  private startTime = 0;
  private inputDuration = 0;
  private processedSeconds = 0;
  private speedEMA = 0;
  private preferHardware = true;
  
  // Debug info
  private debugInfo: WebCodecsDebugInfo = {
    inputFormat: null,
    inputVideoCodec: null,
    inputAudioCodec: null,
    outputFormat: 'MP4',
    outputVideoCodec: 'H.264',
    outputAudioCodec: 'AAC',
    hardwareAcceleration: 'no-preference',
    encodedVideoFrames: 0,
    encodedAudioSamples: 0,
    conversionApiUsed: false,
    error: null,
  };

  async checkSupport(): Promise<ConverterSupport> {
    const support = await checkWebCodecsSupport();
    return {
      supported: support.supported,
      reason: support.reason,
      details: support.details,
    };
  }

  async convert(options: ConvertOptions): Promise<ConversionResult> {
    this.startTime = Date.now();
    this.abortController = new AbortController();
    this.reset();

    const {
      file,
      bitrate = DEFAULT_VIDEO_BITRATE,
      framerate: frameRate = DEFAULT_FRAMERATE,
      onProgress,
      signal,
    } = options;

    // Check abort signal
    if (signal?.aborted) {
      throw new Error('Conversion aborted');
    }

    try {
      // Report initial progress
      this.reportProgress('reading', 0, onProgress);
      
      // Step 1: Create Mediabunny Input from WebM file
      const input = new (await import('mediabunny')).Input({
        source: new (await import('mediabunny')).BlobSource(file),
        formats: [WEBM],
      });
      
      // Get input format info
      const inputFormat = await input.getFormat();
      this.debugInfo.inputFormat = 'WebM';
      console.log('[WebCodecs] Input format:', inputFormat);
      
      // Get video track info
      const format = await input.getFormat();
      this.debugInfo.inputVideoCodec = 'VP8/VP9/AV1';
      // WebM files typically have Opus audio - assume audio is present
      // Actual audio encoding depends on canEncodeAudio check
      this.debugInfo.inputAudioCodec = 'Opus/Vorbis';
      
      // Report analyzing progress
      this.reportProgress('analyzing', 5, onProgress);
      
      // Step 2: Create Mediabunny Output for MP4
      const outputTarget = new BufferTarget();
      const output = new (await import('mediabunny')).Output({
        target: outputTarget,
        format: new Mp4OutputFormat(),
      });
      
      // Step 3: Check codec support
      const videoCodecSupport = await canEncodeVideo('avc');
      const audioCodecSupport = await canEncodeAudio('aac');
      
      if (!videoCodecSupport) {
        throw new Error('H.264 encoding not supported by this device');
      }
      
      console.log('[WebCodecs] Video codec support:', videoCodecSupport);
      console.log('[WebCodecs] Audio codec support:', audioCodecSupport);
      
      this.debugInfo.outputVideoCodec = 'H.264';
      this.debugInfo.outputAudioCodec = audioCodecSupport ? 'AAC' : 'None';
      
      // Step 4: Initialize conversion with Mediabunny Conversion API
      this.reportProgress('converting', 10, onProgress);
      
      this.conversion = await Conversion.init({
        input,
        output,
        video: {
          // Use source resolution automatically (no width/height to preserve aspect ratio)
          // This prevents the "fit" parameter requirement and works correctly for vertical videos
          frameRate,
          codec: 'avc', // H.264
          bitrate: QUALITY_HIGH,
          hardwareAcceleration: this.preferHardware ? 'prefer-hardware' : 'no-preference',
          keyFrameInterval: 2, // Keyframe every 2 seconds
        },
        audio: audioCodecSupport ? {
          codec: 'aac', // AAC
        } : undefined,
      });
      
      this.debugInfo.conversionApiUsed = true;
      console.log('[WebCodecs] Conversion initialized:', {
        isValid: this.conversion.isValid,
        utilizedTracks: this.conversion.utilizedTracks.length,
        discardedTracks: this.conversion.discardedTracks.length,
      });
      
      if (!this.conversion.isValid) {
        console.warn('[WebCodecs] Discarded tracks:', this.conversion.discardedTracks);
      }
      
      // Get input duration - try to get from metadata, fallback to default
      let inputDuration = 30;
      try {
        if (input.getDurationFromMetadata) {
          const result = await input.getDurationFromMetadata();
          inputDuration = typeof result === 'number' ? result : 30;
        }
      } catch (e) {
        console.warn('[WebCodecs] Could not get duration from metadata:', e);
      }
      this.inputDuration = inputDuration || 30;
      
      // Set up progress callback
      this.conversion.onProgress = (progress: number, processedTime: number) => {
        this.processedSeconds = processedTime;
        
        // Calculate speed using EMA
        const elapsed = (Date.now() - this.startTime) / 1000;
        if (elapsed > 0 && processedTime > 0) {
          const instantSpeed = processedTime / elapsed;
          this.speedEMA = this.speedEMA === 0 
            ? instantSpeed 
            : SPEED_EMA_ALPHA * instantSpeed + (1 - SPEED_EMA_ALPHA) * this.speedEMA;
        }
        
        // Progress is 0-1, convert to percentage (10-99 range, reserving 100 for completion)
        const percent = Math.min(99, Math.round(10 + progress * 85));
        
        this.reportProgress('converting', percent, onProgress);
      };
      
      // Step 5: Execute conversion
      this.reportProgress('converting', 15, onProgress);
      await this.conversion.execute();
      
      // Step 6: Finalize
      this.reportProgress('finalizing', 99, onProgress);
      
      // Get the output buffer
      const outputBuffer = outputTarget.buffer;
      if (!outputBuffer) {
        throw new Error('Conversion failed: no output buffer');
      }
      
      // Calculate stats
      const encodeTime = (Date.now() - this.startTime) / 1000;
      const compressionRatio = this.inputDuration > 0 && file.size > 0
        ? Math.round(((file.size - outputBuffer.byteLength) / file.size) * 100)
        : 0;
      const videoBitrate = this.inputDuration > 0
        ? (outputBuffer.byteLength * 8 / this.inputDuration)
        : null;
      
      // hasAudio depends only on AAC encoding support
      // (WebM typically has Opus audio, we encode to AAC if supported)
      const hasAudio = audioCodecSupport;
      
      const result: ConversionResult = {
        blob: new Blob([outputBuffer], { type: 'video/mp4' }),
        filename: getOutputFileName(file.name),
        fileSize: outputBuffer.byteLength,
        inputSize: file.size,
        duration: this.inputDuration,
        videoBitrate: videoBitrate ?? null,
        audioBitrate: hasAudio ? 128 : null,
        compressionRatio,
        encodeTime,
        averageSpeed: encodeTime > 0 ? this.inputDuration / encodeTime : null,
        engine: 'webcodecs',
        hasAudio,
      };
      
      this.reportProgress('complete', 100, onProgress);
      
      console.log('[WebCodecs] Conversion complete:', result);
      
      return result;
    } catch (error) {
      console.error('[WebCodecs] Conversion error:', error);
      this.debugInfo.error = error instanceof Error ? error.message : 'Unknown error';
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  private reportProgress(
    stage: string,
    percent: number,
    callback?: (progress: { percent: number; time: number; stage: string; hasProgress?: boolean; encodedTime?: number | null; encodingSpeed?: number | null; totalDuration?: number | null }) => void
  ) {
    if (callback) {
      callback({
        percent,
        time: this.processedSeconds,
        stage: stage as 'idle' | 'loading' | 'reading' | 'analyzing' | 'converting' | 'finalizing' | 'complete' | 'error',
        hasProgress: true,
        encodedTime: this.processedSeconds,
        encodingSpeed: this.speedEMA > 0 ? this.speedEMA : null,
        totalDuration: this.inputDuration,
      });
    }
  }

  getDebugInfo(): WebCodecsDebugInfo {
    return { ...this.debugInfo };
  }

  private reset(): void {
    this.conversion = null;
    this.inputDuration = 0;
    this.processedSeconds = 0;
    this.speedEMA = 0;
    this.debugInfo = {
      inputFormat: null,
      inputVideoCodec: null,
      inputAudioCodec: null,
      outputFormat: 'MP4',
      outputVideoCodec: 'H.264',
      outputAudioCodec: 'AAC',
      hardwareAcceleration: 'no-preference',
      encodedVideoFrames: 0,
      encodedAudioSamples: 0,
      conversionApiUsed: false,
      error: null,
    };
  }

  async cleanup(): Promise<void> {
    this.abortController?.abort();
    
    if (this.conversion) {
      try {
        await this.conversion.cancel();
      } catch {}
      this.conversion = null;
    }
    
    this.reset();
  }

  abort(): void {
    this.abortController?.abort();
    if (this.conversion) {
      this.conversion.cancel().catch(console.error);
    }
  }
}

// Singleton instance
let webCodecsInstance: WebCodecsConverter | null = null;

export function getWebCodecsConverter(): WebCodecsConverter {
  if (!webCodecsInstance) {
    webCodecsInstance = new WebCodecsConverter();
  }
  return webCodecsInstance;
}
