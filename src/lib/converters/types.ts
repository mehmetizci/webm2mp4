// Conversion Engine Types

import type { WebCodecsCapabilities } from './webCodecsSupport';
import type { QualityPreset } from '@/types/converter';

export type ConversionEngine = 'webcodecs' | 'ffmpeg-wasm';

// Legacy type - kept for backwards compatibility
export type LegacyConversionStage =
  | 'preparing'
  | 'demuxing'
  | 'decoding'
  | 'encoding'
  | 'muxing'
  | 'finalizing';

// Extended stages for better UX
export type ConversionStage =
  | 'idle'
  | 'loading'
  | 'reading'
  | 'analyzing'
  | 'initializing'
  | 'converting'
  | 'encoding'
  | 'finalizing'
  | 'complete'
  | 'error';

export interface VideoMetadata {
  totalDurationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string | null;
}

export interface ConversionProgress {
  percent: number;
  encodedSeconds: number;
  totalSeconds: number | null;
  encodingSpeed: number | null;
  estimatedRemainingSeconds: number | null;
  stage: ConversionStage;
}

export interface ConvertOptions {
  file: File;
  // Quality preset - determines bitrate based on resolution
  quality?: QualityPreset;
  // Resolution options - optional, uses source resolution if not provided
  width?: number;
  height?: number;
  // Fit mode for Mediabunny - required when width and height are both provided
  fit?: 'fill' | 'contain' | 'cover';
  // Encoding options (overrides quality preset if provided)
  bitrate?: number;
  framerate?: number;
  // Callbacks
  onProgress?: (progress: { percent: number; time: number; stage: string; hasProgress?: boolean; encodedTime?: number | null; encodingSpeed?: number | null; totalDuration?: number | null }) => void;
  onMetadata?: (metadata: VideoMetadata) => void;
  signal?: AbortSignal;
}

export interface ConversionResult {
  blob: Blob;
  filename: string;
  fileSize: number;
  inputSize: number;
  duration: number;
  videoBitrate: number | null;
  audioBitrate: number | null;
  compressionRatio: number;
  encodeTime: number;
  averageSpeed: number | null;
  engine: ConversionEngine;
  hasAudio: boolean;
  // Output analysis from the actual MP4 file
  outputAnalysis?: OutputAnalysis;
}

// Detailed analysis of the output MP4 file
export interface OutputAnalysis {
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  frameRate: number;
  duration: number;
  averageVideoBitrate: number; // In bps
  averageAudioBitrate: number | null; // In bps
  container: string;
  fileSizeBytes: number;
  // Target values for comparison
  targetBitrate?: number; // In bps
  bitrateDifference?: number; // Percentage
  totalBitrateBps?: number; // Total bitrate in bps
}

export interface ConverterSupport {
  supported: boolean;
  reason: ConverterSupportReason | null;
  details?: {
    hasVideoDecoder?: boolean;
    hasVideoEncoder?: boolean;
    hasVideoFrame?: boolean;
    hasEncodedVideoChunk?: boolean;
    h264Supported?: boolean;
    hardwareAcceleration?: string | null;
  };
}

export type ConverterSupportReason =
  | 'WEB_CODECS_API_UNAVAILABLE'
  | 'H264_ENCODER_UNSUPPORTED'
  | 'WEB_CODECS_CHECK_FAILED'
  | 'FFMPEG_UNAVAILABLE';

export interface ConversionError {
  code: ConversionErrorCode;
  message: string;
  technical?: string;
}

export type ConversionErrorCode =
  | 'WEB_CODECS_UNAVAILABLE'
  | 'H264_ENCODER_UNSUPPORTED'
  | 'WEBM_DEMUX_FAILED'
  | 'VIDEO_DECODE_FAILED'
  | 'VIDEO_ENCODE_FAILED'
  | 'AUDIO_DECODE_FAILED'
  | 'AUDIO_ENCODE_FAILED'
  | 'MP4_MUX_FAILED'
  | 'WEB_CODECS_ABORTED'
  | 'FFMPEG_UNAVAILABLE'
  | 'FFMPEG_CONVERSION_FAILED'
  | 'FFMPEG_LOAD_FAILED'
  | 'FILE_READ_ERROR'
  | 'OUTPUT_READ_ERROR'
  | 'UNKNOWN';

export interface VideoConverter {
  checkSupport(): Promise<ConverterSupport>;
  convert(options: ConvertOptions): Promise<ConversionResult>;
  cleanup(): Promise<void>;
}

export interface WebCodecsSupport {
  checking: boolean;
  supported: boolean;
  reason: ConverterSupportReason | null;
  details?: ConverterSupport['details'];
}

// Single source of truth for WebCodecs detection state
export type WebCodecsDetectionStatus = 'idle' | 'checking' | 'completed' | 'failed';

export interface WebCodecsDetectionState {
  status: WebCodecsDetectionStatus;
  capabilities: WebCodecsCapabilities | null;
  error: string | null;
  startedAt: number | null;
  updatedAt: number | null;
}

export function createInitialDetectionState(): WebCodecsDetectionState {
  return {
    status: 'idle',
    capabilities: null,
    error: null,
    startedAt: null,
    updatedAt: null,
  };
}
