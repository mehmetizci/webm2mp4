// Low-Level WebCodecs Video Converter using Mediabunny Pipeline
// Direct VideoEncoder control with constant bitrate mode for accurate quality control
// Architecture: Mediabunny (demux/sink) → VideoSampleSource (custom encoder) → Output (mux)

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
  VideoSample,
  AudioSample,
} from 'mediabunny';
import type { VideoConverter, ConvertOptions, ConversionResult, ConverterSupport } from './types';
import type { OutputAnalysis, ConversionErrorCode } from './types';
import { checkWebCodecsSupport } from './webCodecsSupport';

// Iterator result types for async generators
type VideoIteratorResult = IteratorResult<VideoSample, void>;
type AudioIteratorResult = IteratorResult<AudioSample, void>;

// Custom error class with error code for better classification
class ConversionError extends Error {
  constructor(
    message: string,
    public readonly code: ConversionErrorCode = 'UNKNOWN'
  ) {
    super(message);
    this.name = 'ConversionError';
  }
}

// Audio bitrate constant (128 kbps AAC)
const AUDIO_BITRATE_BPS = 128_000;

// Type guard for VideoEncoderConfig bitrateMode
function hasBitrateMode(
  value: unknown
): value is { bitrateMode: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'bitrateMode' in value
  );
}

// Default frame rate
const DEFAULT_FRAMERATE = 30;

// Speed EMA smoothing factor
const SPEED_EMA_ALPHA = 0.3;

// Slow frame threshold in milliseconds (frames above this are considered slow)
const SLOW_FRAME_THRESHOLD_MS = 50;

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

// Sanitize duration values - return null for invalid values
function sanitizeDuration(value: number): number | null {
  if (Number.isFinite(value) && value >= 0) {
    return value;
  }
  return null;
}

// Online statistics for frame timing (Welford's algorithm for numerical stability)
class OnlineStats {
  private count = 0;
  private mean = 0;
  private m2 = 0; // Sum of squared differences from mean
  private min = Infinity;
  private max = -Infinity;
  private samples: number[] = []; // Keep last N samples for approximate percentiles
  private readonly maxSamples = 100; // Keep last 100 samples for p95 approximation

  add(value: number): void {
    this.count++;
    const delta = value - this.mean;
    this.mean += delta / this.count;
    const delta2 = value - this.mean;
    this.m2 += delta * delta2;
    
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    
    // Reservoir sampling for percentile approximation
    if (this.samples.length < this.maxSamples) {
      this.samples.push(value);
    } else {
      // Replace random sample with diminishing probability
      const j = Math.floor(Math.random() * this.count);
      if (j < this.maxSamples) {
        this.samples[j] = value;
      }
    }
  }

  getCount(): number {
    return this.count;
  }

  getMean(): number | null {
    return this.count > 0 ? this.mean : null;
  }

  getMin(): number | null {
    return this.count > 0 ? this.min : null;
  }

  getMax(): number | null {
    return this.count > 0 ? this.max : null;
  }

  getStdDev(): number | null {
    if (this.count < 2) return null;
    return Math.sqrt(this.m2 / (this.count - 1));
  }

  // Approximate percentile using sorted samples
  getPercentile(p: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  getP95(): number | null {
    return this.getPercentile(95);
  }

  getP50(): number | null {
    return this.getPercentile(50);
  }
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
  inputFrameRate: number | null;
  inputVideoCodec: string | null;      // Container codec from Mediabunny (VP8, VP9, AV1, etc.)
  inputVideoCodecString: string | null; // WebCodecs codec string used for decoder test (vp8, vp09, av01, etc.)
  inputDecoderApiAvailable: boolean;
  inputDecoderStatus: 'untested' | 'supported' | 'unsupported' | 'error' | null;
  inputDecoderSupportError: string | null;
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
    codec: string;           // Actual codec string from encoder (e.g., avc1.64001f)
    codecProfile: string | null; // Profile name (High, Main, Baseline)
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
  actualBitrateMode: string | null;
  conversionApiUsed: boolean;
  isValid: boolean;
  usedLowLevelPipeline: boolean;
  conversionId: string | null;
  error: string | null;
  // Performance metrics
  performanceMetrics: {
    // Phase timing (sequential operations)
    metadataMs: number | null;
    inputOpenMs: number | null;
    trackDetectionMs: number | null;
    decoderSupportTestMs: number | null;
    
    // Video processing timing
    videoSampleReadMs: number | null;      // Demux/sample iterator time
    videoPipelineAddMs: number | null;     // Total time in videoEncoderSource.add() including backpressure
    videoPipelineAddMinMs: number | null;  // Min frame time
    videoPipelineAddAvgMs: number | null;   // Average frame time
    videoPipelineAddP50Ms: number | null;  // Median frame time
    videoPipelineAddP95Ms: number | null;  // 95th percentile frame time
    videoPipelineAddMaxMs: number | null;   // Max frame time
    videoPipelineAddSlowCount: number | null; // Frames above slow threshold (>50ms)
    videoFrameCount: number | null;
    firstVideoFrameMs: number | null;
    
    // Audio processing timing
    audioSampleReadMs: number | null;
    audioFrameSubmitMs: number | null;
    audioFrameCount: number | null;
    
    // Post-processing
    encoderFlushMs: number | null;
    muxFinalizeMs: number | null;
    blobCreationMs: number | null;
    
    // Totals
    conversionCoreMs: number | null;   // Processing loop time (sample read + encode)
    totalConversionMs: number | null;  // Full conversion from start to end
    
    // Derived metrics
    effectiveSpeed: number | null;     // Video duration / conversion time
    conversionCompleted: boolean;
  };
}

export class LowLevelWebCodecsConverter implements VideoConverter {
  private debugInfo: LowLevelDebugInfo;
  private conversionStartTime: number = 0; // Using performance.now() for accurate duration measurement
  private inputDuration: number = 0;
  private speedEMA: number = 0;
  private processedSeconds: number = 0;
  private abortController: AbortController | null = null;
  
  // Progress tracking fields
  private lastProgressReportAt: number = 0;
  private lastProgressPercent: number = 0;
  private progressReportIntervalMs: number = 150; // Report progress at most every 150ms
  
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
      inputFrameRate: null,
      inputVideoCodec: null,
      inputVideoCodecString: null,
      inputDecoderApiAvailable: typeof VideoDecoder !== 'undefined',
      inputDecoderStatus: null,
      inputDecoderSupportError: null,
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
      actualBitrateMode: null,
      conversionApiUsed: false,
      isValid: false,
      usedLowLevelPipeline: true,
      conversionId: null,
      error: null,
      // Performance metrics
      performanceMetrics: {
        // Phase timing
        metadataMs: null,
        inputOpenMs: null,
        trackDetectionMs: null,
        decoderSupportTestMs: null,
        
        // Video processing
        videoSampleReadMs: null,
        videoPipelineAddMs: null,
        videoPipelineAddMinMs: null,
        videoPipelineAddAvgMs: null,
        videoPipelineAddP50Ms: null,
        videoPipelineAddP95Ms: null,
        videoPipelineAddMaxMs: null,
        videoPipelineAddSlowCount: null,
        videoFrameCount: null,
        firstVideoFrameMs: null,
        
        // Audio processing
        audioSampleReadMs: null,
        audioFrameSubmitMs: null,
        audioFrameCount: null,
        
        // Post-processing
        encoderFlushMs: null,
        muxFinalizeMs: null,
        blobCreationMs: null,
        
        // Totals
        conversionCoreMs: null,
        totalConversionMs: null,
        
        // Derived
        effectiveSpeed: null,
        conversionCompleted: false,
      },
    };
  }

  getDebugInfo(): LowLevelDebugInfo {
    return { ...this.debugInfo };
  }

  // Validate that the device can decode the input video codec
  // This is critical for Android Chrome which may support H.264 encoding but not VP8/VP9/AV1 decoding
  private async validateDecoderSupport(inputVideoCodec: string | null): Promise<{
    codecString: string;
    status: 'supported' | 'unsupported' | 'untested' | 'error';
    errorMessage?: string;
  }> {
    // Default response
    const defaultResult = {
      codecString: inputVideoCodec || 'unknown',
      status: 'untested' as const,
    };

    if (!inputVideoCodec) {
      console.warn('[Decoder] No input codec detected, skipping decoder validation');
      return defaultResult;
    }

    // Normalize codec string (e.g., "V_VP9" -> "vp09", "V_VP8" -> "vp8", "V_AV1" -> "av01")
    const normalizedCodec = inputVideoCodec.toLowerCase().replace('v_', '').replace('_', '');
    
    // Map to standard WebCodecs codec strings
    let webCodecsCodec: string;
    
    switch (normalizedCodec) {
      case 'vp8':
        webCodecsCodec = 'vp8';
        break;
      case 'vp9':
        webCodecsCodec = 'vp09'; // Generic VP9 (no profile/level info from file)
        break;
      case 'av1':
        webCodecsCodec = 'av01'; // AV1
        break;
      case 'av01':
        webCodecsCodec = 'av01';
        break;
      case 'h264':
      case 'avc1':
        webCodecsCodec = 'avc1.42E01e'; // H.264 Baseline
        break;
      default:
        // Try to use as-is (might work for some codecs)
        webCodecsCodec = inputVideoCodec;
        console.warn(`[Decoder] Unknown codec "${inputVideoCodec}", attempting decoder check anyway`);
    }

    console.log(`[Decoder] Checking decoder support for: ${webCodecsCodec}`);

    // Check if VideoDecoder is available
    if (typeof VideoDecoder === 'undefined') {
      console.warn('[Decoder] VideoDecoder API not available');
      // Let it fail naturally when Mediabunny tries to use it
      return {
        codecString: webCodecsCodec,
        status: 'untested',
      };
    }

    try {
      const config: VideoDecoderConfig = {
        codec: webCodecsCodec,
        codedWidth: 1920,
        codedHeight: 1080,
      };

      // For H.264, we need to specify profile
      if (webCodecsCodec.startsWith('avc1')) {
        (config as VideoDecoderConfig & { description?: Uint8Array }).description = new Uint8Array([
          0x01, // profile
          0x42, // baseline
          0xE0, // compatible profiles
          0x01, // level
          0x0F, // nal units
        ]);
      }

      const support = await VideoDecoder.isConfigSupported(config);
      
      if (!support.supported) {
        const errorMessage = `Bu cihaz ${inputVideoCodec} kodlu videoyu çözemiyor. FFmpeg yöntemini kullanabilirsiniz.`;
        console.error(`[Decoder] NOT SUPPORTED: ${webCodecsCodec}`);
        throw new ConversionError(errorMessage, 'VIDEO_DECODE_FAILED');
      }

      console.log(`[Decoder] ✅ SUPPORTED: ${webCodecsCodec}`);
      
      return {
        codecString: webCodecsCodec,
        status: 'supported',
      };
      
    } catch (error) {
      // Re-throw ConversionError
      if (error instanceof ConversionError) {
        throw error;
      }
      
      // For other errors (like invalid codec string), just warn and continue
      // Mediabunny might handle it differently
      console.warn(`[Decoder] Could not verify decoder support:`, error);
      
      return {
        codecString: webCodecsCodec,
        status: 'error',
      };
    }
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
    this.conversionStartTime = 0;
    this.inputDuration = 0;
    this.speedEMA = 0;
    this.processedSeconds = 0;
    this.lastProgressReportAt = 0;
    this.lastProgressPercent = 0;
  }

  private reportProgress(
    stage: string,
    percent: number,
    onProgress?: (progress: { percent: number; time: number; stage: string; hasProgress?: boolean; encodedTime?: number | null; encodingSpeed?: number | null; totalDuration?: number | null }) => void
  ): void {
    // Throttle progress reports to avoid excessive React re-renders
    const now = performance.now();
    const isFinalUpdate = percent >= 95 || percent === 100;
    
    if (!isFinalUpdate && now - this.lastProgressReportAt < this.progressReportIntervalMs) {
      return; // Skip this report
    }
    
    // Ensure progress is monotonically increasing
    const monotonicPercent = Math.max(this.lastProgressPercent, percent);
    this.lastProgressPercent = monotonicPercent;
    this.lastProgressReportAt = now;
    
    if (onProgress) {
      onProgress({
        percent: monotonicPercent,
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
    this.conversionStartTime = performance.now(); // Use performance.now() for accurate timing

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

    // Performance tracking variables - declared outside try so catch can access them
    let metadataStartMs: number | null = null;
    let inputOpenStartMs: number | null = null;
    let trackDetectionStartMs: number | null = null;
    let decoderTestStartMs: number | null = null;
    let hasInputAudio = false;
    let processingStartTimeMs = 0;
    let videoFrameCount = 0;
    let audioSampleCount = 0;
    let totalSampleReadTimeMs = 0;
    let totalVideoAddTimeMs = 0;
    let totalAudioAddTimeMs = 0;
    let videoSampleReadMs = 0;
    let audioSampleReadMs = 0;
    let firstVideoFrameMs: number | null = null;
    let slowFrameCount = 0;
    const frameStats = new OnlineStats(); // Online statistics for frame timing

    try {
      // Step 1: Create Mediabunny Input
      const Mediabunny = await import('mediabunny');
      inputOpenStartMs = performance.now();
      this.input = new Mediabunny.Input({
        source: new Mediabunny.BlobSource(file),
        formats: [WEBM],
      });
      const inputOpenMs = performance.now() - inputOpenStartMs;
      this.debugInfo.performanceMetrics.inputOpenMs = inputOpenMs;

      this.reportProgress('reading', 0, onProgress);
      
      // Read metadata
      metadataStartMs = performance.now();
      const inputFormat = await this.input.getFormat();
      const metadataFetchMs = performance.now() - metadataStartMs;
      this.debugInfo.performanceMetrics.metadataMs = metadataFetchMs;
      this.debugInfo.inputFormat = 'WebM';
      console.log('[Input] Format:', inputFormat);

      // Get primary video track
      trackDetectionStartMs = performance.now();
      this.videoTrack = await this.input.getPrimaryVideoTrack();
      if (!this.videoTrack) {
        throw new Error('Video track not found in input file');
      }

      // Get primary audio track
      this.audioTrack = await this.input.getPrimaryAudioTrack();
      hasInputAudio = this.audioTrack !== null;
      console.log('[Input] Has audio track:', hasInputAudio);

      // Read video metadata
      const videoWidth = await this.videoTrack.getDisplayWidth();
      const videoHeight = await this.videoTrack.getDisplayHeight();
      const inputVideoCodec = await this.videoTrack.getCodec();
      const trackDetectionMs = performance.now() - trackDetectionStartMs;
      this.debugInfo.performanceMetrics.trackDetectionMs = trackDetectionMs;

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

      // Validate decoder support for input codec
      // This is critical for Android Chrome which may support H.264 encoding but not VP8/VP9/AV1 decoding
      decoderTestStartMs = performance.now();
      const decoderResult = await this.validateDecoderSupport(inputVideoCodec);
      const decoderTestMs = performance.now() - decoderTestStartMs;
      this.debugInfo.performanceMetrics.decoderSupportTestMs = decoderTestMs;
      
      // Store decoder info in debugInfo (for external use)
      this.debugInfo.inputVideoCodecString = decoderResult.codecString;
      this.debugInfo.inputDecoderStatus = decoderResult.status;
      this.debugInfo.inputDecoderSupportError = decoderResult.errorMessage || null;
      
      // Log decoder validation result
      if (decoderResult.status === 'supported') {
        console.log(`[Decoder] Validation result: ${decoderResult.codecString} - Supported`);
      } else if (decoderResult.status === 'unsupported') {
        console.error(`[Decoder] Validation result: ${decoderResult.codecString} - NOT SUPPORTED`);
      } else if (decoderResult.status === 'error') {
        console.error(`[Decoder] Validation result: ${decoderResult.codecString} - Error: ${decoderResult.errorMessage}`);
      }

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
        'WebCodecs Codec String': decoderResult.codecString,
        'Input Audio Codec': inputAudioCodec ?? 'none',
        'Has Audio': hasInputAudio ? 'Yes' : 'No',
        'Input Duration': `${inputDuration.toFixed(1)}s`,
        'Detected Frame Rate': `${detectedFrameRate} fps`,
      });
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      // Store input frame rate in debugInfo
      this.debugInfo.inputFrameRate = detectedFrameRate;

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
      const targetVideoBitrateBps = targetBitrateBps ?? encoderConfig.encoder.bitrate;

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
            bitrateMode: hasBitrateMode(config) ? config.bitrateMode : 'N/A',
          });
          
          // Update encoder config with actual codec string from encoder
          if (this.debugInfo.encoderConfig) {
            this.debugInfo.encoderConfig.codec = config.codec;
            // Extract profile from codec string (e.g., avc1.64001f -> High)
            if (config.codec.startsWith('avc1.')) {
              const codecSuffix = config.codec.substring(5); // e.g., 64001f
              if (codecSuffix === '64001f') {
                this.debugInfo.encoderConfig.codecProfile = 'High';
              } else if (codecSuffix === '4D401f') {
                this.debugInfo.encoderConfig.codecProfile = 'Main';
              } else if (codecSuffix === '42E01e') {
                this.debugInfo.encoderConfig.codecProfile = 'Baseline';
              }
            }
          }
          
          // Check if encoder returned bitrateMode - this indicates browser support
          if (hasBitrateMode(config)) {
            this.debugInfo.bitrateModeSupported = config.bitrateMode === bitrateMode;
            this.debugInfo.actualBitrateMode = config.bitrateMode;
          } else {
            this.debugInfo.bitrateModeSupported = false;
            this.debugInfo.actualBitrateMode = null;
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
      // Note: actual codec string will be updated in onEncoderConfig callback
      this.debugInfo.encoderConfig = {
        codec: 'avc', // Will be updated with actual codec string from encoder
        codecProfile: null, // Will be updated with actual profile name from encoder
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

      // Step 7: Create sample sinks to read from input
      const MediabunnyVideoSampleSink = Mediabunny.VideoSampleSink;
      const videoSink = new MediabunnyVideoSampleSink(this.videoTrack);

      // Step 8: Create audio sink if available
      let audioSink: InstanceType<typeof Mediabunny.AudioSampleSink> | null = null;
      let hasAudioTrack = false;
      if (hasInputAudio && this.audioTrack) {
        audioSink = new Mediabunny.AudioSampleSink(this.audioTrack);
        hasAudioTrack = true;
        console.log('[Audio] Input has audio track, will interleave samples');
      } else {
        console.log('[Audio] No input audio track found');
      }

      // Step 9: Interleaved audio/video processing
      // Note: Mediabunny VideoSample/AudioSample timestamp is in SECONDS
      console.log('[Processing] Starting interleaved audio/video encoding...');
      
      // Reset counters for processing loop
      videoFrameCount = 0;
      audioSampleCount = 0;
      totalSampleReadTimeMs = 0;
      totalVideoAddTimeMs = 0;
      totalAudioAddTimeMs = 0;
      videoSampleReadMs = 0;
      audioSampleReadMs = 0;
      firstVideoFrameMs = null;
      
      processingStartTimeMs = performance.now();
      const startTimeMs = Date.now();
      
      let sampleReadStartTime = 0;
      
      // Track processed time based on sample timestamps
      const updateProcessedSeconds = (sampleTimestamp: number, sampleDuration: number) => {
        // Mediabunny timestamps are in SECONDS
        const sampleEndSeconds = sampleTimestamp + (sampleDuration || 0);
        this.processedSeconds = Math.max(this.processedSeconds, sampleEndSeconds);
      };
      
      // Update progress based on media timestamp (not wall clock)
      const updateProgress = () => {
        const elapsedMs = Date.now() - startTimeMs;
        const elapsedSec = elapsedMs / 1000;
        
        // Calculate encoding speed: processed media time / wall clock time
        const instantSpeed = elapsedSec > 0
          ? this.processedSeconds / elapsedSec
          : 0;
        
        this.speedEMA = this.speedEMA === 0
          ? instantSpeed
          : SPEED_EMA_ALPHA * instantSpeed + (1 - SPEED_EMA_ALPHA) * this.speedEMA;
        
        // Calculate progress based on media timestamp ratio
        const mediaRatio = this.inputDuration > 0
          ? this.processedSeconds / this.inputDuration
          : 0;
        
        // Progress: start at 10%, end at 90%
        const encodingProgress = Math.min(
          90,
          Math.max(10, 10 + mediaRatio * 80)
        );
        
        this.reportProgress('encoding', encodingProgress, onProgress);
      };

      // CRITICAL: Create iterators ONCE before the loop
      // This prevents resource exhaustion on mobile devices
      const videoIterator = videoSink.samples();
      const audioIterator = audioSink?.samples() ?? null;
      
      // Track pending samples (peeked but not yet consumed)
      let pendingVideoSample: VideoSample | null = null;
      let pendingAudioSample: AudioSample | null = null;

      // Helper to get next video sample
      const getNextVideoSample = async (): Promise<VideoSample | null> => {
        if (pendingVideoSample) {
          const sample = pendingVideoSample;
          pendingVideoSample = null;
          return sample;
        }
        
        sampleReadStartTime = performance.now();
        const result: VideoIteratorResult = await videoIterator.next();
        const readTime = performance.now() - sampleReadStartTime;
        videoSampleReadMs += readTime;
        totalSampleReadTimeMs += readTime;
        
        if (result.done) {
          return null;
        }
        return result.value;
      };

      // Helper to peek next video sample without consuming
      const peekNextVideoSample = async (): Promise<VideoSample | null> => {
        if (pendingVideoSample) return pendingVideoSample;
        
        sampleReadStartTime = performance.now();
        const result: VideoIteratorResult = await videoIterator.next();
        const readTime = performance.now() - sampleReadStartTime;
        videoSampleReadMs += readTime;
        totalSampleReadTimeMs += readTime;
        
        if (result.done) {
          return null;
        }
        pendingVideoSample = result.value;
        return pendingVideoSample;
      };

      // Helper to get next audio sample
      const getNextAudioSample = async (): Promise<AudioSample | null> => {
        if (pendingAudioSample) {
          const sample = pendingAudioSample;
          pendingAudioSample = null;
          return sample;
        }
        if (!audioIterator) return null;
        
        sampleReadStartTime = performance.now();
        const result: AudioIteratorResult = await audioIterator.next();
        const readTime = performance.now() - sampleReadStartTime;
        audioSampleReadMs += readTime;
        totalSampleReadTimeMs += readTime;
        
        if (result.done) {
          return null;
        }
        return result.value;
      };

      // Helper to peek next audio sample without consuming
      const peekNextAudioSample = async (): Promise<AudioSample | null> => {
        if (pendingAudioSample) return pendingAudioSample;
        if (!audioIterator) return null;
        
        sampleReadStartTime = performance.now();
        const result: AudioIteratorResult = await audioIterator.next();
        const readTime = performance.now() - sampleReadStartTime;
        audioSampleReadMs += readTime;
        totalSampleReadTimeMs += readTime;
        
        if (result.done) {
          return null;
        }
        pendingAudioSample = result.value;
        return pendingAudioSample;
      };

      // Helper to close a sample safely
      const closeSample = (sample: VideoSample | AudioSample | null) => {
        if (sample) {
          try {
            sample.close();
          } catch (e) {
            // Ignore close errors
          }
        }
      };

      // Interleaved processing loop
      let videoDone = false;
      let audioDone = !audioSink; // Start as done if no audio
      let currentVideoSample: VideoSample | null = null;
      let currentAudioSample: AudioSample | null = null;

      try {
        while (!videoDone || !audioDone) {
          // Check abort
          if (signal?.aborted) {
            throw new ConversionError('Conversion aborted', 'WEB_CODECS_ABORTED');
          }

          // Peek at next samples to decide which to process
          let nextVideo: VideoSample | null = null;
          let nextAudio: AudioSample | null = null;
          
          if (!videoDone && !currentVideoSample) {
            nextVideo = await peekNextVideoSample();
            if (!nextVideo) videoDone = true;
          }
          
          if (!audioDone && !currentAudioSample && audioIterator) {
            nextAudio = await peekNextAudioSample();
            if (!nextAudio) audioDone = true;
          }

          // Determine which sample to process next based on timestamp
          if (!videoDone && !currentVideoSample && nextVideo) {
            if (!nextAudio || nextVideo.timestamp <= nextAudio.timestamp) {
              currentVideoSample = await getNextVideoSample();
            }
          }
          
          if (!audioDone && !currentAudioSample && nextAudio) {
            if (!currentVideoSample || (nextAudio && (!nextVideo || nextAudio.timestamp < nextVideo.timestamp))) {
              currentAudioSample = await getNextAudioSample();
            }
          }

          // Check if both are done
          if (!currentVideoSample && !currentAudioSample) {
            break;
          }

          // Process video sample
          if (currentVideoSample) {
            try {
              // Track first video frame time (time from processing start to first add() call)
              if (firstVideoFrameMs === null && videoFrameCount === 0) {
                firstVideoFrameMs = performance.now() - processingStartTimeMs;
              }
              
              // Update processed seconds from video sample timestamp
              updateProcessedSeconds(currentVideoSample.timestamp, currentVideoSample.duration ?? (1 / detectedFrameRate));
              updateProgress();
              
              // Measure video pipeline add time (includes decode, transform, encode, backpressure)
              const videoAddStart = performance.now();
              await this.videoEncoderSource.add(currentVideoSample);
              const singleFrameMs = performance.now() - videoAddStart;
              totalVideoAddTimeMs += singleFrameMs;
              
              // Track frame statistics
              frameStats.add(singleFrameMs);
              if (singleFrameMs > SLOW_FRAME_THRESHOLD_MS) {
                slowFrameCount++;
              }
              
              videoFrameCount++;
            } finally {
              // ALWAYS close the sample, even on error
              closeSample(currentVideoSample);
              currentVideoSample = null;
            }
          } else if (currentAudioSample) {
            try {
              // Process audio sample
              // Update processed seconds from audio sample timestamp
              updateProcessedSeconds(currentAudioSample.timestamp, currentAudioSample.duration ?? 0.02); // ~20ms default audio frame
              
              // Measure audio add time
              const audioAddStart = performance.now();
              await this.audioEncoderSource!.add(currentAudioSample);
              totalAudioAddTimeMs += performance.now() - audioAddStart;
              
              audioSampleCount++;
            } finally {
              // ALWAYS close the sample, even on error
              closeSample(currentAudioSample);
              currentAudioSample = null;
            }
          }
        }
      } finally {
        // Cleanup: close any pending samples
        closeSample(pendingVideoSample);
        closeSample(pendingAudioSample);
        closeSample(currentVideoSample);
        closeSample(currentAudioSample);
      }

      // Update processedSeconds to exact input duration after all samples processed
      this.processedSeconds = this.inputDuration;
      updateProgress(); // Final progress update

      console.log(`[Processing] Encoded ${videoFrameCount} video frames in ${((Date.now() - startTimeMs) / 1000).toFixed(1)}s`);
      console.log(`[Processing] Encoded ${audioSampleCount} audio samples`);
      
      // Verify audio output
      if (hasAudioTrack && this.outputAudioTrack) {
        console.log('[Audio] Output audio track verified');
      } else if (hasAudioTrack && !this.outputAudioTrack) {
        console.warn('[Audio] WARNING: Input had audio but output audio track is null!');
      }

      // Step 10: Finalize output
      this.reportProgress('finalizing', 95, onProgress);
      console.log('[Output] Finalizing...');
      
      // Measure encoder flush time
      const flushStartTime = performance.now();
      if (this.videoEncoderSource) {
        // @ts-expect-error - VideoSampleSource might have end method (not in types)
        await this.videoEncoderSource.end?.();
      }
      if (this.audioEncoderSource) {
        // @ts-expect-error - AudioSampleSource might have end method (not in types)
        await this.audioEncoderSource.end?.();
      }
      const encoderFlushMs = performance.now() - flushStartTime;
      
      // Measure mux/finalize time
      const muxStartTime = performance.now();
      await this.output.finalize();
      const muxFinalizeMs = performance.now() - muxStartTime;
      console.log('[Output] Finalized');

      // Step 12: Get output buffer
      const outputBuffer = outputTarget.buffer;
      if (!outputBuffer) {
        throw new Error('Conversion failed: no output buffer');
      }

      // Measure blob creation time
      const blobStartTime = performance.now();
      const blob = new Blob([outputBuffer], { type: 'video/mp4' });
      const blobCreationMs = performance.now() - blobStartTime;

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
        
        // Audio verification: if input had audio but output doesn't, throw error
        if (hasInputAudio && !hasOutputAudio) {
          console.error('❌ AUDIO VERIFICATION FAILED: Input has audio but output has no audio track!');
          throw new Error('Audio track missing in output: input had audio but output does not contain audio');
        }

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

      // Performance summary
      const totalConversionTimeMs = performance.now() - processingStartTimeMs;
      const videoAddPercent = totalConversionTimeMs > 0 ? (totalVideoAddTimeMs / totalConversionTimeMs * 100).toFixed(1) : '0';
      const sampleReadPercent = totalConversionTimeMs > 0 ? (totalSampleReadTimeMs / totalConversionTimeMs * 100).toFixed(1) : '0';
      const flushPercent = totalConversionTimeMs > 0 ? (encoderFlushMs / totalConversionTimeMs * 100).toFixed(1) : '0';
      const muxPercent = totalConversionTimeMs > 0 ? (muxFinalizeMs / totalConversionTimeMs * 100).toFixed(1) : '0';
      
      // Calculate total conversion time (from start to end, using same time source)
      const totalConversionMs = sanitizeDuration(performance.now() - this.conversionStartTime);
      
      // Calculate effective speed
      const effectiveSpeed = this.inputDuration > 0 && totalConversionTimeMs !== null && totalConversionTimeMs > 0
        ? this.inputDuration / (totalConversionTimeMs / 1000)
        : null;
      
      // Store performance metrics in debugInfo
      this.debugInfo.performanceMetrics = {
        // Phase timing
        metadataMs: sanitizeDuration(this.debugInfo.performanceMetrics.metadataMs),
        inputOpenMs: sanitizeDuration(this.debugInfo.performanceMetrics.inputOpenMs),
        trackDetectionMs: sanitizeDuration(this.debugInfo.performanceMetrics.trackDetectionMs),
        decoderSupportTestMs: sanitizeDuration(this.debugInfo.performanceMetrics.decoderSupportTestMs),
        
        // Video processing
        videoSampleReadMs: sanitizeDuration(videoSampleReadMs),
        videoPipelineAddMs: sanitizeDuration(totalVideoAddTimeMs),
        videoPipelineAddMinMs: frameStats.getMin(),
        videoPipelineAddAvgMs: frameStats.getMean(),
        videoPipelineAddP50Ms: frameStats.getP50(),
        videoPipelineAddP95Ms: frameStats.getP95(),
        videoPipelineAddMaxMs: frameStats.getMax(),
        videoPipelineAddSlowCount: slowFrameCount,
        videoFrameCount: videoFrameCount,
        firstVideoFrameMs: firstVideoFrameMs !== null ? sanitizeDuration(firstVideoFrameMs) : null,
        
        // Audio processing
        audioSampleReadMs: hasInputAudio ? sanitizeDuration(audioSampleReadMs) : null,
        audioFrameSubmitMs: hasInputAudio ? sanitizeDuration(totalAudioAddTimeMs) : null,
        audioFrameCount: hasInputAudio ? audioSampleCount : null,
        
        // Post-processing
        encoderFlushMs: sanitizeDuration(encoderFlushMs),
        muxFinalizeMs: sanitizeDuration(muxFinalizeMs),
        blobCreationMs: sanitizeDuration(blobCreationMs),
        
        // Totals
        conversionCoreMs: sanitizeDuration(totalConversionTimeMs),
        totalConversionMs: totalConversionMs,
        
        // Derived
        effectiveSpeed: effectiveSpeed !== null ? sanitizeDuration(effectiveSpeed) : null,
        conversionCompleted: true,
      };
      
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('          PERFORMANCE METRICS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('[Timing]');
      console.table({
        'Total conversion (ms)': totalConversionTimeMs.toFixed(0),
        'Video frames': videoFrameCount,
        'Audio samples': audioSampleCount,
        'Slow frames (>50ms)': slowFrameCount,
      });
      console.log('[Time Breakdown]');
      console.table({
        'Video Sample Read (ms)': totalSampleReadTimeMs.toFixed(0) + ` (${sampleReadPercent}%)`,
        'Video Pipeline Add (ms)': totalVideoAddTimeMs.toFixed(0) + ` (${videoAddPercent}%)`,
        'Encoder flush (ms)': encoderFlushMs.toFixed(0) + ` (${flushPercent}%)`,
        'Mux/finalize (ms)': muxFinalizeMs.toFixed(0) + ` (${muxPercent}%)`,
        'Blob creation (ms)': blobCreationMs.toFixed(0),
      });
      console.log('[Frame Statistics]');
      console.table({
        'Min frame (ms)': frameStats.getMin()?.toFixed(2) ?? '-',
        'Avg frame (ms)': frameStats.getMean()?.toFixed(2) ?? '-',
        'P50 frame (ms)': frameStats.getP50()?.toFixed(2) ?? '-',
        'P95 frame (ms)': frameStats.getP95()?.toFixed(2) ?? '-',
        'Max frame (ms)': frameStats.getMax()?.toFixed(2) ?? '-',
      });
      // Identify bottleneck
      if (parseFloat(videoAddPercent) > 60) {
        console.log('⚠️ BOTTLENECK: videoEncoderSource.add() is the main bottleneck (~' + videoAddPercent + '%)');
        console.log('   Note: add() includes decode + transform + encode + backpressure waiting');
      } else if (parseFloat(sampleReadPercent) > 40) {
        console.log('⚠️ BOTTLENECK: Sample reading/demuxing is the main bottleneck');
      } else {
        console.log('✅ No single bottleneck detected');
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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

      // Log performance summary
      const formatMs = (ms: number): string => {
        if (ms < 1000) return `${ms.toFixed(0)}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
        const minutes = Math.floor(ms / 60000);
        const seconds = ((ms % 60000) / 1000).toFixed(0);
        return `${minutes}m ${seconds}s`;
      };
      console.log(
        `[Performance] Metadata: ${formatMs(this.debugInfo.performanceMetrics.metadataMs ?? 0)} | ` +
        `Input: ${formatMs(this.debugInfo.performanceMetrics.inputOpenMs ?? 0)} | ` +
        `Video Read: ${formatMs(videoSampleReadMs)} | ` +
        `Pipeline Add: ${formatMs(totalVideoAddTimeMs)} | ` +
        `Flush: ${formatMs(encoderFlushMs)} | ` +
        `Mux: ${formatMs(muxFinalizeMs)} | ` +
        `Total: ${formatMs(totalConversionTimeMs)} | ` +
        `Speed: ${effectiveSpeed !== null ? effectiveSpeed.toFixed(2) + 'x' : 'N/A'}`
      );

      // Calculate stats
      const encodeTime = totalConversionMs !== null && totalConversionMs > 0 
        ? totalConversionMs / 1000 
        : 0; // Default to 0 if something goes wrong
      const compressionRatio = this.inputDuration > 0 && file.size > 0
        ? Math.round(((file.size - outputBuffer.byteLength) / file.size) * 100)
        : 0;

      this.debugInfo.isValid = true;
      this.debugInfo.error = null;

      // Release runtime resources (keep debug info)
      this.releaseRuntimeResources();

      const result: ConversionResult = {
        blob,
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
      
      // Store partial performance metrics on error
      const partialConversionTimeMs = processingStartTimeMs > 0 ? performance.now() - processingStartTimeMs : null;
      const totalTimeMs = this.conversionStartTime > 0 ? sanitizeDuration(performance.now() - this.conversionStartTime) : null;
      
      this.debugInfo.performanceMetrics = {
        // Phase timing
        metadataMs: this.debugInfo.performanceMetrics.metadataMs ?? null,
        inputOpenMs: this.debugInfo.performanceMetrics.inputOpenMs ?? null,
        trackDetectionMs: this.debugInfo.performanceMetrics.trackDetectionMs ?? null,
        decoderSupportTestMs: this.debugInfo.performanceMetrics.decoderSupportTestMs ?? null,
        
        // Video processing
        videoSampleReadMs: sanitizeDuration(videoSampleReadMs),
        videoPipelineAddMs: sanitizeDuration(totalVideoAddTimeMs),
        videoPipelineAddMinMs: frameStats.getMin(),
        videoPipelineAddAvgMs: frameStats.getMean(),
        videoPipelineAddP50Ms: frameStats.getP50(),
        videoPipelineAddP95Ms: frameStats.getP95(),
        videoPipelineAddMaxMs: frameStats.getMax(),
        videoPipelineAddSlowCount: slowFrameCount,
        videoFrameCount: videoFrameCount,
        firstVideoFrameMs: firstVideoFrameMs !== null ? sanitizeDuration(firstVideoFrameMs) : null,
        
        // Audio processing
        audioSampleReadMs: hasInputAudio ? sanitizeDuration(audioSampleReadMs) : null,
        audioFrameSubmitMs: hasInputAudio ? sanitizeDuration(totalAudioAddTimeMs) : null,
        audioFrameCount: hasInputAudio ? audioSampleCount : null,
        
        // Post-processing
        encoderFlushMs: null,
        muxFinalizeMs: null,
        blobCreationMs: null,
        
        // Totals
        conversionCoreMs: partialConversionTimeMs !== null ? sanitizeDuration(partialConversionTimeMs) : null,
        totalConversionMs: totalTimeMs,
        
        // Derived
        effectiveSpeed: null,
        conversionCompleted: false,
      };
      
      this.debugInfo.error = error instanceof Error ? error.message : String(error);
      this.debugInfo.isValid = false;

      // Release runtime resources
      try {
        await this.cancelOutput();
      } catch (e) {
        // Ignore cancel errors
      }
      this.releaseRuntimeResources();

      // Re-throw with error code for better error classification
      if (error instanceof ConversionError) {
        throw error;
      }
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
