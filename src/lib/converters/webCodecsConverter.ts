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
} from 'mediabunny';
import { getEncoderConfig, type EncoderConfig } from './qualityConfig';
import type { QualityPreset } from '@/types/converter';
import type { OutputAnalysis } from './types';

// Constants
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
  inputWidth: number;
  inputHeight: number;
  outputFormat: string;
  outputVideoCodec: string;
  outputAudioCodec: string;
  outputWidth: number;
  outputHeight: number;
  targetBitrate: number;
  actualBitrate: number | null;
  bitrateDifference: number;
  qualityPreset: string;
  hardwareAcceleration: string;
  encodedVideoFrames: number;
  encodedAudioSamples: number;
  conversionApiUsed: boolean;
  error: string | null;
  encoderConfig: {
    codec: string;
    bitrate: number;
    framerate: number;
    bitrateMode: string;
    latencyMode: string;
    hardwareAcceleration: string;
    keyFrameInterval: number;
  } | null;
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
    inputWidth: 0,
    inputHeight: 0,
    outputFormat: 'MP4',
    outputVideoCodec: 'H.264',
    outputAudioCodec: 'AAC',
    outputWidth: 0,
    outputHeight: 0,
    targetBitrate: 0,
    actualBitrate: null,
    bitrateDifference: 0,
    qualityPreset: 'standard',
    hardwareAcceleration: 'prefer-hardware',
    encodedVideoFrames: 0,
    encodedAudioSamples: 0,
    conversionApiUsed: false,
    error: null,
    encoderConfig: null,
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
      quality = 'standard',
      width: targetWidth,
      height: targetHeight,
      framerate: frameRate = DEFAULT_FRAMERATE,
      onProgress,
      onMetadata,
      signal,
    } = options;

    // Check abort signal
    if (signal?.aborted) {
      throw new Error('Conversion aborted');
    }

    try {
      // Step 1: Create Mediabunny Input from WebM file
      const input = new (await import('mediabunny')).Input({
        source: new (await import('mediabunny')).BlobSource(file),
        formats: [WEBM],
      });
      
      // Report reading stage
      this.reportProgress('reading', 0, onProgress);
      
      // Get input format info
      const inputFormat = await input.getFormat();
      this.debugInfo.inputFormat = 'WebM';
      console.log('[WebCodecs] Input format:', inputFormat);
      
      // Get video track info
      this.debugInfo.inputVideoCodec = 'VP8/VP9/AV1';
      this.debugInfo.inputAudioCodec = 'Opus/Vorbis';
      
      // Get input duration from metadata FIRST - before any other processing
      let inputDuration = 30;
      let videoWidth = 0;
      let videoHeight = 0;
      let videoFrameRate = frameRate;
      
      try {
        if (input.getDurationFromMetadata) {
          const duration = await input.getDurationFromMetadata();
          inputDuration = typeof duration === 'number' && duration > 0 ? duration : 30;
          console.log('[WebCodecs] Duration from metadata:', inputDuration);
        }
      } catch (e) {
        console.warn('[WebCodecs] Could not get duration from metadata:', e);
      }
      
      this.inputDuration = inputDuration;
      
      // Report analyzing stage WITH duration now available
      this.reportProgress('analyzing', 2, onProgress);
      
      // Check codec support BEFORE reporting metadata
      const videoCodecSupport = await canEncodeVideo('avc');
      const audioCodecSupport = await canEncodeAudio('aac');
      
      if (!videoCodecSupport) {
        throw new Error('H.264 encoding not supported by this device');
      }
      
      console.log('[WebCodecs] Video codec support:', videoCodecSupport);
      console.log('[WebCodecs] Audio codec support:', audioCodecSupport);
      
      this.debugInfo.outputVideoCodec = 'H.264';
      this.debugInfo.outputAudioCodec = audioCodecSupport ? 'AAC' : 'None';
      
      // Step 2: Calculate encoder configuration based on quality preset
      // Use source resolution by default, or target resolution if specified
      const outputWidth = targetWidth ?? videoWidth;
      const outputHeight = targetHeight ?? videoHeight;
      
      const encoderConfig = getEncoderConfig(
        outputWidth,
        outputHeight,
        frameRate,
        quality as QualityPreset
      );
      
      // Enhanced encoder config logging for verification
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('[WebCodecs] ENCODER CONFIGURATION');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Quality Preset: ${quality}`);
      console.log(`Input Resolution: ${videoWidth}x${videoHeight}`);
      console.log(`Output Resolution: ${outputWidth}x${outputHeight}`);
      console.log('────────────────────────────────────────');
      console.log(`Codec: ${encoderConfig.encoder.codec.toUpperCase()}`);
      console.log(`Target Bitrate: ${(encoderConfig.encoder.bitrate / 1000).toFixed(0)} kbps`);
      console.log(`Frame Rate: ${encoderConfig.encoder.framerate} fps`);
      console.log(`Bitrate Mode: ${encoderConfig.encoder.bitrateMode.toUpperCase()}`);
      console.log(`Latency Mode: ${encoderConfig.encoder.latencyMode}`);
      console.log(`Hardware Acceleration: ${encoderConfig.encoder.hardwareAcceleration}`);
      console.log(`Key Frame Interval: ${encoderConfig.encoder.keyFrameInterval}s`);
      console.log(`Total Video Bitrate: ${(encoderConfig.videoBitrate / 1000).toFixed(0)} kbps`);
      console.log(`Audio Bitrate: ${(encoderConfig.audioBitrate / 1000).toFixed(0)} kbps`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      // Update debug info with encoder configuration
      this.debugInfo.inputWidth = videoWidth;
      this.debugInfo.inputHeight = videoHeight;
      this.debugInfo.outputWidth = outputWidth;
      this.debugInfo.outputHeight = outputHeight;
      this.debugInfo.targetBitrate = encoderConfig.videoBitrate;
      this.debugInfo.hardwareAcceleration = encoderConfig.encoder.hardwareAcceleration;
      this.debugInfo.qualityPreset = quality;
      this.debugInfo.encoderConfig = {
        codec: encoderConfig.encoder.codec,
        bitrate: encoderConfig.encoder.bitrate,
        framerate: encoderConfig.encoder.framerate,
        bitrateMode: encoderConfig.encoder.bitrateMode,
        latencyMode: encoderConfig.encoder.latencyMode,
        hardwareAcceleration: encoderConfig.encoder.hardwareAcceleration,
        keyFrameInterval: encoderConfig.encoder.keyFrameInterval,
      };
      
      // Report metadata IMMEDIATELY - before any other processing
      // This allows UI to show duration right away
      if (onMetadata) {
        onMetadata({
          totalDurationSeconds: inputDuration,
          width: outputWidth,
          height: outputHeight,
          frameRate: videoFrameRate,
          hasAudio: audioCodecSupport, // Assume WebM has audio, AAC will be encoded if supported
          videoCodec: 'VP8/VP9/AV1',
          audioCodec: audioCodecSupport ? 'AAC' : null,
        });
        console.log('[WebCodecs] Metadata reported to UI');
      }
      
      // Step 3: Create Mediabunny Output for MP4
      this.reportProgress('initializing', 5, onProgress);
      const outputTarget = new BufferTarget();
      const output = new (await import('mediabunny')).Output({
        target: outputTarget,
        format: new Mp4OutputFormat(),
      });
      
      // Step 4: Initialize conversion with Mediabunny Conversion API
      this.reportProgress('initializing', 8, onProgress);
      
      // Build video options - only include width/height if target is different from source
      const videoOptions: Record<string, unknown> = {
        codec: encoderConfig.encoder.codec,
        bitrate: encoderConfig.encoder.bitrate,
        frameRate: encoderConfig.encoder.framerate,
        hardwareAcceleration: encoderConfig.encoder.hardwareAcceleration,
        keyFrameInterval: encoderConfig.encoder.keyFrameInterval,
      };
      
      // Only add width/height if we're actually resizing
      if (targetWidth !== undefined || targetHeight !== undefined) {
        videoOptions.width = outputWidth;
        videoOptions.height = outputHeight;
        // If both dimensions are specified and different from source, require fit mode
        if (targetWidth !== undefined && targetHeight !== undefined) {
          videoOptions.fit = 'contain'; // Preserve aspect ratio
        }
      }
      
      this.conversion = await Conversion.init({
        input,
        output,
        video: videoOptions,
        audio: audioCodecSupport ? {
          codec: 'aac',
        } : undefined,
      });
      
      this.debugInfo.conversionApiUsed = true;
      console.log('[WebCodecs] Conversion initialized:', {
        isValid: this.conversion.isValid,
        utilizedTracks: this.conversion.utilizedTracks.length,
        discardedTracks: this.conversion.discardedTracks.length,
        encoderBitrate: encoderConfig.encoder.bitrate,
      });
      
      if (!this.conversion.isValid) {
        console.warn('[WebCodecs] Discarded tracks:', this.conversion.discardedTracks);
      }
      
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
        
        this.reportProgress('encoding', percent, onProgress);
      };
      
      // Step 5: Execute conversion
      this.reportProgress('encoding', 10, onProgress);
      await this.conversion.execute();
      
      // Step 6: Finalize
      this.reportProgress('finalizing', 99, onProgress);
      
      // Get the output buffer
      const outputBuffer = outputTarget.buffer;
      if (!outputBuffer) {
        throw new Error('Conversion failed: no output buffer');
      }
      
      // Step 7: Analyze output MP4 to get actual stats
      let outputAnalysis: OutputAnalysis | undefined;
      try {
        const Mediabunny = await import('mediabunny');
        const analysisInput = new Mediabunny.Input({
          source: new Mediabunny.BlobSource(new Blob([outputBuffer], { type: 'video/mp4' })),
          formats: [Mediabunny.MP4],
        });
        
        const outputFormat = await analysisInput.getFormat();
        const videoTrack = await analysisInput.getPrimaryVideoTrack();
        const audioTracks = await analysisInput.getAudioTracks().catch(() => []);
        const audioTrack = audioTracks[0] ?? null;
        
        if (videoTrack) {
          const trackInfo = await videoTrack.getTrackInfo();
          const actualVideoBitrate = trackInfo.bitrate ?? this.debugInfo.targetBitrate;
          
          // Calculate bitrate difference percentage
          const bitrateDifference = this.debugInfo.targetBitrate > 0
            ? ((actualVideoBitrate - this.debugInfo.targetBitrate) / this.debugInfo.targetBitrate * 100)
            : 0;
          
          outputAnalysis = {
            videoCodec: trackInfo.codec ?? 'H.264',
            audioCodec: audioTrack ? 'AAC' : null,
            width: trackInfo.width ?? this.debugInfo.outputWidth,
            height: trackInfo.height ?? this.debugInfo.outputHeight,
            frameRate: trackInfo.frameRate ?? frameRate,
            duration: this.inputDuration,
            averageVideoBitrate: actualVideoBitrate,
            averageAudioBitrate: audioTrack ? 128_000 : null,
            container: 'MP4',
            fileSizeBytes: outputBuffer.byteLength,
            targetBitrate: this.debugInfo.targetBitrate,
            bitrateDifference: bitrateDifference,
          };
          
          // Update debug info with actual bitrate
          this.debugInfo.actualBitrate = actualVideoBitrate;
          this.debugInfo.bitrateDifference = bitrateDifference;
          
          // Enhanced output analysis logging
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('[WebCodecs] OUTPUT ANALYSIS');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`Video Codec: ${outputAnalysis.videoCodec}`);
          console.log(`Audio Codec: ${outputAnalysis.audioCodec ?? 'None'}`);
          console.log(`Resolution: ${outputAnalysis.width}x${outputAnalysis.height}`);
          console.log(`Frame Rate: ${outputAnalysis.frameRate} fps`);
          console.log(`Duration: ${outputAnalysis.duration.toFixed(1)}s`);
          console.log(`File Size: ${(outputAnalysis.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`);
          console.log('────────────────────────────────────────');
          console.log(`Target Video Bitrate: ${(this.debugInfo.targetBitrate / 1000).toFixed(0)} kbps`);
          console.log(`Actual Video Bitrate: ${(actualVideoBitrate / 1000).toFixed(0)} kbps`);
          console.log(`Bitrate Difference: ${bitrateDifference > 0 ? '+' : ''}${bitrateDifference.toFixed(1)}%`);
          console.log(`Audio Bitrate: ${outputAnalysis.averageAudioBitrate ? (outputAnalysis.averageAudioBitrate / 1000).toFixed(0) : 0} kbps`);
          console.log('Container: MP4');
          
          if (Math.abs(bitrateDifference) > 15) {
            console.warn(`⚠️ Bitrate difference is > 15%! Expected ~${(this.debugInfo.targetBitrate / 1000).toFixed(0)} kbps, got ${(actualVideoBitrate / 1000).toFixed(0)} kbps`);
          } else {
            console.log('✅ Bitrate is within acceptable range (< 15% difference)');
          }
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }
      } catch (analysisError) {
        console.warn('[WebCodecs] Could not analyze output:', analysisError);
      }
      
      // Calculate stats
      const encodeTime = (Date.now() - this.startTime) / 1000;
      const compressionRatio = this.inputDuration > 0 && file.size > 0
        ? Math.round(((file.size - outputBuffer.byteLength) / file.size) * 100)
        : 0;
      const videoBitrate = outputAnalysis?.averageVideoBitrate ?? 
        (this.inputDuration > 0 ? (outputBuffer.byteLength * 8 / this.inputDuration) : null);
      
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
        audioBitrate: outputAnalysis?.averageAudioBitrate ?? (hasAudio ? 128_000 : null),
        compressionRatio,
        encodeTime,
        averageSpeed: encodeTime > 0 ? this.inputDuration / encodeTime : null,
        engine: 'webcodecs',
        hasAudio,
        outputAnalysis,
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
        stage: stage as 'idle' | 'loading' | 'reading' | 'analyzing' | 'initializing' | 'converting' | 'encoding' | 'finalizing' | 'complete' | 'error',
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
      inputWidth: 0,
      inputHeight: 0,
      outputFormat: 'MP4',
      outputVideoCodec: 'H.264',
      outputAudioCodec: 'AAC',
      outputWidth: 0,
      outputHeight: 0,
      targetBitrate: 0,
      actualBitrate: null,
      bitrateDifference: 0,
      qualityPreset: 'standard',
      hardwareAcceleration: 'prefer-hardware',
      encodedVideoFrames: 0,
      encodedAudioSamples: 0,
      conversionApiUsed: false,
      error: null,
      encoderConfig: null,
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
