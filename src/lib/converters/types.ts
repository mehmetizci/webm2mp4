// Conversion Engine Types

export type ConversionEngine = 'webcodecs' | 'ffmpeg';

export type ConversionStage =
  | 'preparing'
  | 'demuxing'
  | 'decoding'
  | 'encoding'
  | 'muxing'
  | 'finalizing';

export interface ConversionProgress {
  percent: number | null;
  encodedSeconds: number;
  totalSeconds: number | null;
  encodingSpeed: number | null;
  estimatedRemainingSeconds: number | null;
  stage: ConversionStage;
}

export interface ConvertOptions {
  file: File;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  onProgress?: (progress: ConversionProgress) => void;
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
import type { WebCodecsCapabilities } from './webCodecsSupport';

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
