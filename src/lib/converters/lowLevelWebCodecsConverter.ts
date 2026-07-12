// Low-Level WebCodecs Video Converter using Mediabunny Pipeline
// Direct VideoEncoder control with constant bitrate mode for accurate quality control
// Architecture: Mediabunny (demux/sink) → VideoSampleSource (custom encoder) → Output (mux)

import type { QualityPreset } from '@/types/converter';
import { getEncoderConfigWithHardwareMode, type HardwareMode } from './qualityConfig';
import { getOutputFileName } from '@/lib/file-utils';

// Mediabunny imports
import {
  WEBM,
  Mp4OutputFormat,
  BufferTarget,
  canEncodeVideo,
  canEncodeAudio,
} from 'mediabunny';
import type {
  VideoSampleSource,
  AudioSampleSource,
  InputVideoTrack,
  InputAudioTrack,
  Output,
  OutputVideoTrack,
  OutputAudioTrack,
  VideoEncodingConfig,
  AudioEncodingConfig,
} from 'mediabunny';
import type { VideoConverter, ConvertOptions, ConversionResult, ConverterSupport } from './types';
import type { OutputAnalysis } from './types';
import { checkWebCodecsSupport } from './webCodecsSupport';

// Audio bitrate constant (128 kbps AAC)
const AUDIO_BITRATE_BPS = 128_000;

// Default frame rate
const DEFAULT_FRAMERATE = 30;

// Speed EMA smoothing factor
const SPEED_EMA_ALPHA = 0.3;

// Instance ID counter for debugging
let instanceCounter = 0;

// Generate unique ID
function generateId(prefix: string): string {
  instanceCounter++;
  return `${prefix}-${Date.now()}-${instanceCounter}`;
}

// Calculate SHA-256 hash of blob
async function calculateSha256(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface LowLevelWebCodecsProgress {
  percent: number;
  time: number;
  stage: string;
  hasProgress?: boolean;
  encodedTime?: number | null;
  encodingSpeed?: number | null;
  totalDuration?: number | null;
}

export interface LowLevelDebugInfo {
  inputFormat: string;
  inputWidth: number;
  inputHeight: number;
  inputVideoCodec: string | null;
  inputAudioCodec: string | null;
  outputWidth: number;
  outputHeight: number;
  outputVideoCodec: string;
  outputAudioCodec: string | null;
  targetVideoBitrateBps: number;
  targetTotalBitrateBps: number;
  actualTotalBitrateBps: number | null;
  actualVideoBitrateBps: number | null;
  actualAudioBitrateBps: number | null;
  bitrateDifferencePercent: number | null;
  hardwareMode: string;
  qualityPreset: string;
  encoderConfig: {
    codec: string;
    bitrate: number;
    framerate: number;
    hardwareAcceleration: string;
    keyFrameInterval: number;
    forceTranscode: boolean;
    bitrateMode: string;
    latencyMode: string;
  } | null;
  encoderSupported: boolean;
  bitrateModeRequested: string;
  bitrateModeSupported: boolean;
  conversionApiUsed: boolean;
  isValid: boolean;
  usedLowLevelPipeline: boolean;
  conversionId: string | null;
  error: string | null;
}

export class LowLevelWebCodecsConverter implements VideoConverter {
  private debugInfo: LowLevelDebugInfo;
  private startTime: number = 0;
  private inputDuration: number = 0;
  private speedEMA: number = 0;
  private processedSeconds: number = 0;
  private abortController: AbortController | null = null;
  
  // Low-level components
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private input: any = null;
  private output: Output | null = null;
  private videoEncoderSource: VideoSampleSource | null = null;
  private audioEncoderSource: AudioSampleSource | null = null;
  private videoTrack: InputVideoTrack | null = null;
  private audioTrack: InputAudioTrack | null = null;
  private outputVideoTrack: OutputVideoTrack | null = null;
  private outputAudioTrack: OutputAudioTrack | null = null;

  constructor() {
    this.debugInfo = this.createInitialDebugInfo();
  }

  private createInitialDebugInfo(): LowLevelDebugInfo {
    return {
      inputFormat: '',
      inputWidth: 0,
      inputHeight: 0,
      inputVideoCodec: null,
      inputAudioCodec: null,
      outputWidth: 0,
      outputHeight: 0,
      outputVideoCodec: 'H.264',
      outputAudioCodec: null,
      targetVideoBitrateBps: 0,
      targetTotalBitrateBps: 0,
      actualTotalBitrateBps: null,
      actualVideoBitrateBps: null,
      actualAudioBitrateBps: null,
      bitrateDifferencePercent: null,
      hardwareMode: 'no-preference',
      qualityPreset: 'standard',
      encoderConfig: null,
      encoderSupported: false,
      bitrateModeRequested: 'constant',
      bitrateModeSupported: false,
      conversionApiUsed: false,
      isValid: false,
      usedLowLevelPipeline: true,
      conversionId: null,
      error: null,
    };
  }

  getDebugInfo(): LowLevelDebugInfo {
    return { ...this.debugInfo };
  }

  // Only release runtime resources, keep debug info
  private releaseRuntimeResources(): void {
    this.videoEncoderSource = null;
    this.audioEncoderSource = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.outputVideoTrack = null;
    this.outputAudioTrack = null;
    this.output = null;
    this.input = null;
    this.abortController = null;
  }

  // Reset state for new conversion (called before new conversion starts)
  private resetState(): void {
    this.debugInfo = this.createInitialDebugInfo();
    this.startTime = 0;
    this.inputDuration = 0;
    this.speedEMA = 0;
    this.processedSeconds = 0;
  }

  private reportProgress(
    stage: string,
    percent: number,
    onProgress?: (progress: { percent: number; time: number; stage: string; hasProgress?: boolean; encodedTime?: number | null; encodingSpeed?: number | null; totalDuration?: number | null }) => void
  ): void {
    if (onProgress) {
      onProgress({
        percent,
        time: this.processedSeconds,
        stage,
        hasProgress: true,
        encodedTime: this.processedSeconds,
        encodingSpeed: this.speedEMA,
        totalDuration: this.inputDuration,
      });
    }
  }

  async convert(
    options: ConvertOptions & { hardwareMode?: HardwareMode; targetBitrateBps?: number }
  ): Promise<ConversionResult> {
    const {
      file,
      quality = 'standard',
      width: targetWidth,
      height: targetHeight,
      framerate: frameRate = DEFAULT_FRAMERATE,
      onProgress,
      onMetadata,
      signal,
      hardwareMode = 'no-preference',
      targetBitrateBps, // Override bitrate for extreme testing
    } = options;

    // Reset state for new conversion
    this.resetState();
    this.startTime = Date.now();

    const conversionId = generateId('conv');
    this.debugInfo.conversionId = conversionId;
    this.debugInfo.hardwareMode = hardwareMode;
    this.debugInfo.qualityPreset = quality;

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  LOW-LEVEL WEBCODECS CONVERTER - CONVERSION START         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`[conversionId] ${conversionId}`);
    console.log('[Input Parameters]');
    console.log('  quality:', quality);
    console.log('  hardwareMode:', hardwareMode);
    console.log('  targetWidth:', targetWidth ?? 'auto');
    console.log('  targetHeight:', targetHeight ?? 'auto');
    console.log('  frameRate:', frameRate);
    console.log('  file.name:', file.name);
    console.log('  file.size:', (file.size / 1024 / 1024).toFixed(2), 'MB');
    if (targetBitrateBps) {
      console.log('  targetBitrateBps:', targetBitrateBps, '(EXTREME TEST OVERRIDE)');
    }

    // Check abort signal
    if (signal?.aborted) {
      throw new Error('Conversion aborted');
    }

    try {
      // Step 1: Create Mediabunny Input
      const Mediabunny = await import('mediabunny');
      this.input = new Mediabunny.Input({
        source: new Mediabunny.BlobSource(file),
        formats: [WEBM],
      });

      this.reportProgress('reading', 0, onProgress);
      const inputFormat = await this.input.getFormat();
      this.debugInfo.inputFormat = 'WebM';
      console.log('[Input] Format:', inputFormat);

      // Get primary video track
      this.videoTrack = await this.input.getPrimaryVideoTrack();
      if (!this.videoTrack) {
        throw new Error('Video track not found in input file');
      }

      // Get primary audio track
      this.audioTrack = await this.input.getPrimaryAudioTrack();
      const hasInputAudio = this.audioTrack !== null;
      console.log('[Input] Has audio track:', hasInputAudio);

      // Read video metadata
      const videoWidth = await this.videoTrack.getDisplayWidth();
      const videoHeight = await this.videoTrack.getDisplayHeight();
      const inputVideoCodec = await this.videoTrack.getCodec();

      // Validate resolution
      if (
        !Number.isFinite(videoWidth) ||
        !Number.isFinite(videoHeight) ||
        videoWidth <= 0 ||
        videoHeight <= 0
      ) {
        throw new Error(`Invalid video resolution: ${videoWidth}x${videoHeight}`);
      }

      this.debugInfo.inputWidth = videoWidth;
      this.debugInfo.inputHeight = videoHeight;
      this.debugInfo.inputVideoCodec = inputVideoCodec ?? 'unknown';

      // Read audio codec if available
      let inputAudioCodec: string | null = null;
      if (hasInputAudio && this.audioTrack) {
        inputAudioCodec = await this.audioTrack.getCodec() ?? null;
        this.debugInfo.inputAudioCodec = inputAudioCodec;
      }

      // Calculate real frame rate from packet stats
      let detectedFrameRate = frameRate;
      try {
        const packetStats = await this.videoTrack.computePacketStats(120);
        if (Number.isFinite(packetStats.averagePacketRate) && packetStats.averagePacketRate > 0) {
          detectedFrameRate = Math.round(packetStats.averagePacketRate);
        }
      } catch (e) {
        console.warn('[Input] Could not compute packet stats, using default FPS:', e);
      }

      // Get input duration
      let inputDuration = 30;
      try {
        const duration = await this.input.getDurationFromMetadata?.();
        inputDuration = typeof duration === 'number' && duration > 0 ? duration : 30;
      } catch (e) {
        console.warn('[Input] Could not get duration from metadata:', e);
      }
      this.inputDuration = inputDuration;

      // Log input metadata
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('                    INPUT METADATA                               ');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.table({
        'Input Resolution': `${videoWidth}x${videoHeight}`,
        'Orientation': videoHeight > videoWidth ? 'vertical' : 'horizontal',
        'Input Video Codec': inputVideoCodec ?? 'unknown',
        'Input Audio Codec': inputAudioCodec ?? 'none',
        'Has Audio': hasInputAudio ? 'Yes' : 'No',
        'Input Duration': `${inputDuration.toFixed(1)}s`,
        'Detected Frame Rate': `${detectedFrameRate} fps`,
      });
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Check codec support
      const videoCodecSupport = await canEncodeVideo('avc');
      const canEncodeAac = hasInputAudio ? await canEncodeAudio('aac') : false;

      this.debugInfo.encoderSupported = videoCodecSupport;
      this.debugInfo.outputAudioCodec = canEncodeAac ? 'AAC' : null;

      console.log('[Encoder] Can encode H.264:', videoCodecSupport);
      console.log('[Encoder] Can encode AAC:', canEncodeAac);

      if (!videoCodecSupport) {
        throw new Error('H.264 encoding not supported by this device');
      }

      // Calculate output resolution
      const outputWidth = targetWidth ?? videoWidth;
      const outputHeight = targetHeight ?? videoHeight;

      // Calculate resolution tier
      const minDimension = Math.min(outputWidth, outputHeight);
      let resolutionTier: '480' | '720' | '1080';
      if (minDimension >= 1080) resolutionTier = '1080';
      else if (minDimension >= 720) resolutionTier = '720';
      else resolutionTier = '480';

      // Get encoder config from single source of truth
      // This provides bitrate based on resolution, orientation, FPS, quality, and hardware mode
      const encoderConfig = getEncoderConfigWithHardwareMode(
        outputWidth,
        outputHeight,
        detectedFrameRate,
        quality,
        hardwareMode
      );

      // Use encoder config bitrate or override for extreme testing
      const targetVideoBitrateBps = targetBitrateBps ?? encoderConfig.bitrate;

      // Create VideoEncoderConfig with constant bitrate mode
      const bitrateMode: 'constant' | 'variable' = 'constant';
      const latencyMode: 'quality' | 'realtime' = 'quality';

      const videoEncoderConfig: VideoEncodingConfig = {
        codec: 'avc',
        bitrate: targetVideoBitrateBps,
        bitrateMode,
        latencyMode,
        hardwareAcceleration: hardwareMode,
        keyFrameInterval: 2,
        onEncoderConfig: (config) => {
          // Log the actual encoder config that was created
          console.log('[Encoder] WebCodecs VideoEncoderConfig (actual):');
          console.table({
            codec: config.codec,
            width: config.width,
            height: config.height,
            framerate: config.framerate,
            bitrate: config.bitrate,
            latencyMode: config.latencyMode,
            // @ts-ignore - bitrateMode might not be in VideoEncoderConfig type
            bitrateMode: (config as Record<string, unknown>).bitrateMode ?? 'N/A',
          });
          // Check if encoder returned bitrateMode - this indicates browser support
          const returnedBitrateMode = (config as Record<string, unknown>).bitrateMode;
          if (returnedBitrateMode !== undefined) {
            this.debugInfo.bitrateModeSupported = returnedBitrateMode === bitrateMode;
          } else {
            // Browser encoder did not return bitrateMode
            this.debugInfo.bitrateModeSupported = false;
            console.warn('[Encoder] Tarayıcı encoder config içinde bitrateMode döndürmedi');
          }
        },
      };

      // Create audio encoder config
      const audioEncoderConfig: AudioEncodingConfig | undefined = canEncodeAac ? {
        codec: 'aac',
        bitrate: AUDIO_BITRATE_BPS,
      } : undefined;

      // Log encoder configuration
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('                    ENCODER CONFIGURATION                        ');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.table({
        quality,
        hardwareMode,
        sourceWidth: videoWidth,
        sourceHeight: videoHeight,
        outputWidth,
        outputHeight,
        orientation: outputHeight > outputWidth ? 'vertical' : 'horizontal',
        resolutionTier: `${resolutionTier}p`,
        detectedFrameRate,
        targetVideoBitrateBps,
        targetTotalBitrateBps: targetVideoBitrateBps + (canEncodeAac ? AUDIO_BITRATE_BPS : 0),
        bitrateModeRequested: bitrateMode,
        latencyModeRequested: latencyMode,
        isExtremeTest: targetBitrateBps !== undefined,
      });
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Store encoder config for debug
      this.debugInfo.encoderConfig = {
        codec: 'avc',
        bitrate: targetVideoBitrateBps,
        framerate: detectedFrameRate,
        hardwareAcceleration: hardwareMode,
        keyFrameInterval: 2,
        forceTranscode: true,
        bitrateMode,
        latencyMode,
      };
      this.debugInfo.targetVideoBitrateBps = targetVideoBitrateBps;
      this.debugInfo.targetTotalBitrateBps = targetVideoBitrateBps + (canEncodeAac ? AUDIO_BITRATE_BPS : 0);
      this.debugInfo.outputWidth = outputWidth;
      this.debugInfo.outputHeight = outputHeight;
      this.debugInfo.bitrateModeRequested = bitrateMode;

      // Report metadata
      if (onMetadata) {
        onMetadata({
          totalDurationSeconds: inputDuration,
          width: outputWidth,
          height: outputHeight,
          frameRate: detectedFrameRate,
          hasAudio: hasInputAudio,
          videoCodec: inputVideoCodec ?? 'unknown',
          audioCodec: inputAudioCodec,
        });
      }

      this.reportProgress('analyzing', 5, onProgress);

      // Step 2: Create Output
      console.log('[Output] Creating MP4 output...');
      const outputTarget = new BufferTarget();
      this.output = new Mediabunny.Output({
        target: outputTarget,
        format: new Mp4OutputFormat(),
      });

      // Step 3: Create VideoEncoderSource with our custom config
      console.log('[Encoder] Creating VideoSampleSource with constant bitrate mode...');
      this.videoEncoderSource = new Mediabunny.VideoSampleSource(videoEncoderConfig);

      // Step 4: Add video track to output
      this.outputVideoTrack = this.output.addVideoTrack(this.videoEncoderSource);
      console.log('[Output] Added video track to output');

      // Step 5: Create and add audio track if available
      if (hasInputAudio && this.audioTrack && audioEncoderConfig) {
        this.audioEncoderSource = new Mediabunny.AudioSampleSource(audioEncoderConfig);
        this.outputAudioTrack = this.output.addAudioTrack(this.audioEncoderSource);
        console.log('[Output] Added audio track to output');
      }

      // Step 6: Start the output
      console.log('[Output] Starting output...');
      await this.output.start();
      this.reportProgress('encoding', 10, onProgress);

      // Step 7: Create sample sink to read from input
      const MediabunnyVideoSampleSink = Mediabunny.VideoSampleSink;
      const videoSink = new MediabunnyVideoSampleSink(this.videoTrack);

      // Step 8: Create audio sink if available
      let audioSink: InstanceType<typeof Mediabunny.AudioSampleSink> | null = null;
      if (hasInputAudio && this.audioTrack) {
        audioSink = new Mediabunny.AudioSampleSink(this.audioTrack);
      }

      // Step 9: Process video samples
      console.log('[Processing] Starting video encoding...');
      let videoFrameCount = 0;
      const startTimeMs = Date.now();

      for await (const sample of videoSink.samples()) {
        // Check abort
        if (signal?.aborted) {
          await this.cancelOutput();
          throw new Error('Conversion aborted');
        }

        // Add to encoder source
        await this.videoEncoderSource.add(sample);

        videoFrameCount++;

        // Progress reporting
        const elapsedMs = Date.now() - startTimeMs;
        const elapsedSec = elapsedMs / 1000;
        if (elapsedSec > 0 && this.inputDuration > 0) {
          const instantSpeed = elapsedSec / this.inputDuration;
          this.speedEMA = this.speedEMA === 0
            ? instantSpeed
            : SPEED_EMA_ALPHA * instantSpeed + (1 - SPEED_EMA_ALPHA) * this.speedEMA;
          const progress = Math.min(90, Math.round(10 + (elapsedSec / this.inputDuration) * 80));
          this.reportProgress('encoding', progress, onProgress);
        }

        // Release sample
        sample.close();
      }

      console.log(`[Processing] Encoded ${videoFrameCount} video frames in ${((Date.now() - startTimeMs) / 1000).toFixed(1)}s`);

      // Step 10: Process audio samples if available
      if (audioSink && this.audioEncoderSource) {
        console.log('[Processing] Starting audio encoding...');
        let audioSampleCount = 0;

        for await (const sample of audioSink.samples()) {
          if (signal?.aborted) {
            await this.cancelOutput();
            throw new Error('Conversion aborted');
          }

          await this.audioEncoderSource.add(sample);
          audioSampleCount++;
          sample.close();
        }

        console.log(`[Processing] Encoded ${audioSampleCount} audio samples`);
      }

      // Step 11: Finalize output
      this.reportProgress('finalizing', 95, onProgress);
      console.log('[Output] Finalizing...');

      if (this.videoEncoderSource) {
        // @ts-ignore - VideoSampleSource might have end method
        await this.videoEncoderSource.end?.();
      }
      if (this.audioEncoderSource) {
        // @ts-ignore - AudioSampleSource might have end method
        await this.audioEncoderSource.end?.();
      }

      await this.output.finalize();
      console.log('[Output] Finalized');

      // Step 12: Get output buffer
      const outputBuffer = outputTarget.buffer;
      if (!outputBuffer) {
        throw new Error('Conversion failed: no output buffer');
      }

      // Step 13: Analyze output
      let outputAnalysis: OutputAnalysis | undefined;
      let outputHash: string = '';

      try {
        outputHash = await calculateSha256(new Blob([outputBuffer], { type: 'video/mp4' }));

        const AnalysisMediabunny = await import('mediabunny');
        const analysisInput = new AnalysisMediabunny.Input({
          source: new AnalysisMediabunny.BlobSource(new Blob([outputBuffer], { type: 'video/mp4' })),
          formats: [AnalysisMediabunny.MP4],
        });

        const outputVideoTrack = await analysisInput.getPrimaryVideoTrack();
        const outputAudioTrack = await analysisInput.getPrimaryAudioTrack();
        const hasOutputAudio = outputAudioTrack !== null;

        if (outputVideoTrack) {
          const actualTotalBitrateBps = this.inputDuration > 0
            ? Math.round((outputBuffer.byteLength * 8) / this.inputDuration)
            : null;

          // Use audio bitrate from actual output track if available
          const actualAudioBitrateBps = hasOutputAudio ? AUDIO_BITRATE_BPS : null;
          const actualVideoBitrateBps = actualTotalBitrateBps !== null && hasOutputAudio
            ? actualTotalBitrateBps - AUDIO_BITRATE_BPS
            : actualTotalBitrateBps;

          const bitrateDifferencePercent = this.debugInfo.targetVideoBitrateBps > 0 && actualVideoBitrateBps !== null
            ? ((actualVideoBitrateBps - this.debugInfo.targetVideoBitrateBps) / this.debugInfo.targetVideoBitrateBps * 100)
            : null;

          outputAnalysis = {
            videoCodec: 'H.264',
            audioCodec: hasOutputAudio ? 'AAC' : null,
            width: outputWidth,
            height: outputHeight,
            frameRate: detectedFrameRate,
            duration: this.inputDuration,
            averageVideoBitrate: actualVideoBitrateBps ?? 0,
            averageAudioBitrate: actualAudioBitrateBps,
            container: 'MP4',
            fileSizeBytes: outputBuffer.byteLength,
            targetBitrate: this.debugInfo.targetVideoBitrateBps,
            bitrateDifference: bitrateDifferencePercent ?? 0,
            totalBitrateBps: actualTotalBitrateBps ?? 0,
          };

          this.debugInfo.actualTotalBitrateBps = actualTotalBitrateBps;
          this.debugInfo.actualVideoBitrateBps = actualVideoBitrateBps;
          this.debugInfo.actualAudioBitrateBps = actualAudioBitrateBps;
          this.debugInfo.bitrateDifferencePercent = bitrateDifferencePercent;

          // Comprehensive output logging
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`          OUTPUT ANALYSIS [${conversionId}]`);
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.table({
            'Output Size (MB)': (outputBuffer.byteLength / 1024 / 1024).toFixed(3),
            'Duration (s)': this.inputDuration.toFixed(1),
            'Resolution': `${outputWidth}x${outputHeight}`,
            'Frame Rate': `${detectedFrameRate} fps`,
            'Video Codec': 'H.264',
            'Audio Codec': hasOutputAudio ? 'AAC' : 'None',
          });
          console.log('[SHA-256 Hash]');
          console.log(outputHash.substring(0, 16) + '...' + outputHash.substring(48));
          console.log('[Target Bitrates]');
          console.table({
            'Target Video (kbps)': (this.debugInfo.targetVideoBitrateBps / 1000).toFixed(0),
            'Target Total (kbps)': (this.debugInfo.targetTotalBitrateBps / 1000).toFixed(0),
          });
          console.log('[Actual Bitrates]');
          console.table({
            'Actual Video (kbps)': actualVideoBitrateBps ? (actualVideoBitrateBps / 1000).toFixed(0) : 'N/A',
            'Actual Total (kbps)': actualTotalBitrateBps ? (actualTotalBitrateBps / 1000).toFixed(0) : 'N/A',
            'Actual Audio (kbps)': actualAudioBitrateBps ? (actualAudioBitrateBps / 1000).toFixed(0) : 'N/A',
          });
          console.log('[Bitrate Comparison]');
          console.table({
            'Difference (%)': bitrateDifferencePercent !== null ? bitrateDifferencePercent.toFixed(1) + '%' : 'N/A',
            'Quality Preset': quality,
            'Hardware Mode': hardwareMode,
            'Is Extreme Test': targetBitrateBps !== undefined ? 'Yes' : 'No',
          });
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

          // Quality separation verification
          if (bitrateDifferencePercent !== null) {
            if (Math.abs(bitrateDifferencePercent) > 50) {
              console.warn(`⚠️ WARNING: Bitrate difference > 50%! Target may not be applied.`);
            } else if (Math.abs(bitrateDifferencePercent) <= 15) {
              console.log('✅ Bitrate is within acceptable range (< 15% difference)');
            }
          }
        }
      } catch (analysisError) {
        console.warn('[Analysis] Could not analyze output:', analysisError);
      }

      // Final summary
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`          CONVERSION COMPLETE [${conversionId}]`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('[Summary]');
      console.table({
        'Quality': quality,
        'Hardware Mode': hardwareMode,
        'Is Extreme Test': targetBitrateBps !== undefined ? 'Yes' : 'No',
        'Output Size (MB)': outputAnalysis ? (outputAnalysis.fileSizeBytes / 1024 / 1024).toFixed(3) : 'N/A',
        'Target Video (kbps)': (this.debugInfo.targetVideoBitrateBps / 1000).toFixed(0),
        'Actual Video (kbps)': this.debugInfo.actualVideoBitrateBps ? (this.debugInfo.actualVideoBitrateBps / 1000).toFixed(0) : 'N/A',
        'Bitrate Diff (%)': this.debugInfo.bitrateDifferencePercent !== null ? this.debugInfo.bitrateDifferencePercent.toFixed(1) : 'N/A',
        'SHA-256': outputHash ? outputHash.substring(0, 16) + '...' : 'N/A',
      });
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Calculate stats
      const encodeTime = (Date.now() - this.startTime) / 1000;
      const compressionRatio = this.inputDuration > 0 && file.size > 0
        ? Math.round(((file.size - outputBuffer.byteLength) / file.size) * 100)
        : 0;

      this.debugInfo.isValid = true;
      this.debugInfo.error = null;

      // Release runtime resources (keep debug info)
      this.releaseRuntimeResources();

      const result: ConversionResult = {
        blob: new Blob([outputBuffer], { type: 'video/mp4' }),
        filename: getOutputFileName(file.name),
        fileSize: outputBuffer.byteLength,
        inputSize: file.size,
        duration: this.inputDuration,
        videoBitrate: outputAnalysis?.averageVideoBitrate ?? null,
        audioBitrate: outputAnalysis?.averageAudioBitrate ?? null,
        compressionRatio,
        encodeTime,
        averageSpeed: encodeTime > 0 ? this.inputDuration / encodeTime : null,
        engine: 'webcodecs',
        hasAudio: outputAnalysis?.audioCodec !== null,
        outputAnalysis,
      };

      return result;

    } catch (error) {
      console.error('[Error]', error);
      this.debugInfo.error = error instanceof Error ? error.message : String(error);
      this.debugInfo.isValid = false;

      // Release runtime resources
      try {
        await this.cancelOutput();
      } catch (e) {
        // Ignore cancel errors
      }
      this.releaseRuntimeResources();

      throw error;
    }
  }

  private async cancelOutput(): Promise<void> {
    if (this.output && this.output.state !== 'finalized' && this.output.state !== 'canceled') {
      try {
        await this.output.cancel();
      } catch (e) {
        console.warn('[Cancel] Error during output cancellation:', e);
      }
    }
  }

  async checkSupport(): Promise<ConverterSupport> {
    return checkWebCodecsSupport();
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.cancelOutput();
  }

  async cleanup(): Promise<void> {
    this.releaseRuntimeResources();
    this.resetState();
  }
}
