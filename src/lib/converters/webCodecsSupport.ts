// WebCodecs Support Check

import type { WebCodecsSupport, ConverterSupport, ConverterSupportReason } from './types';

export async function checkWebCodecsSupport(): Promise<WebCodecsSupport> {
  // Check if WebCodecs API is available
  if (
    typeof VideoDecoder === 'undefined' ||
    typeof VideoEncoder === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    typeof EncodedVideoChunk === 'undefined'
  ) {
    return {
      checking: false,
      supported: false,
      reason: 'WEB_CODECS_API_UNAVAILABLE',
      details: {
        hasVideoDecoder: typeof VideoDecoder !== 'undefined',
        hasVideoEncoder: typeof VideoEncoder !== 'undefined',
        hasVideoFrame: typeof VideoFrame !== 'undefined',
        hasEncodedVideoChunk: typeof EncodedVideoChunk !== 'undefined',
      },
    };
  }

  // Check if H.264 encoder is supported
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec: 'avc1.64001f', // H.264 High Profile Level 3.1
      width: 720,
      height: 1280,
      bitrate: 650_000,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
      avc: {
        format: 'annexb',
      },
    });

    if (!result.supported) {
      return {
        checking: false,
        supported: false,
        reason: 'H264_ENCODER_UNSUPPORTED',
        details: {
          hasVideoDecoder: true,
          hasVideoEncoder: true,
          hasVideoFrame: true,
          hasEncodedVideoChunk: true,
          h264Supported: false,
        },
      };
    }

    return {
      checking: false,
      supported: true,
      reason: null,
      details: {
        hasVideoDecoder: true,
        hasVideoEncoder: true,
        hasVideoFrame: true,
        hasEncodedVideoChunk: true,
        h264Supported: true,
        hardwareAcceleration: result.config?.hardwareAcceleration ?? null,
      },
    };
  } catch (error) {
    return {
      checking: false,
      supported: false,
      reason: 'WEB_CODECS_CHECK_FAILED',
      details: {
        hasVideoDecoder: true,
        hasVideoEncoder: true,
        hasVideoFrame: true,
        hasEncodedVideoChunk: true,
      },
    };
  }
}

export function checkFFmpegSupport(): ConverterSupport {
  // Check basic browser support for FFmpeg
  if (
    typeof WebAssembly === 'undefined' ||
    typeof Worker === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL === 'undefined'
  ) {
    return {
      supported: false,
      reason: 'FFMPEG_UNAVAILABLE',
    };
  }

  return {
    supported: true,
    reason: null,
  };
}

export function getReasonMessage(reason: ConverterSupportReason | null): string | null {
  switch (reason) {
    case 'WEB_CODECS_API_UNAVAILABLE':
      return 'Tarayıcınız WebCodecs API\'sini desteklemiyor. FFmpeg WebAssembly yöntemini kullanabilirsiniz.';
    case 'H264_ENCODER_UNSUPPORTED':
      return 'Tarayıcınız WebCodecs API\'sini destekliyor ancak H.264 video kodlamayı desteklemiyor. FFmpeg WebAssembly yöntemini kullanabilirsiniz.';
    case 'WEB_CODECS_CHECK_FAILED':
      return 'WebCodecs uyumluluğu kontrol edilemedi. FFmpeg WebAssembly yöntemini kullanabilirsiniz.';
    case 'FFMPEG_UNAVAILABLE':
      return 'Bu tarayıcı FFmpeg WebAssembly için gerekli özellikleri desteklemiyor.';
    default:
      return null;
  }
}
