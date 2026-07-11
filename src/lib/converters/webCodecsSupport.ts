// WebCodecs Support Check

import type { WebCodecsSupport, ConverterSupport, ConverterSupportReason } from './types';

export interface WebCodecsCapabilities {
  secureContext: boolean;
  videoEncoder: boolean;
  videoDecoder: boolean;
  videoFrame: boolean;
  mediaRecorder: boolean;
  h264Supported: boolean;
  h264BaselineSupported: boolean;
  testedCodec: string;
  testedProfile: string;
  testedLevel: string;
  hardwareAcceleration: string;
  failureReason: string | null;
  errorDetails: string | null;
}

// Check if we're in a browser environment
function isBrowser(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.document !== 'undefined'
  );
}

// Check if we have a secure context (HTTPS or localhost)
function isSecureContext(): boolean {
  if (!isBrowser()) return false;
  return window.isSecureContext ?? true; // Default to true if not available
}

// Detect available WebCodecs APIs
function detectWebCodecsAPIs(): {
  videoEncoder: boolean;
  videoDecoder: boolean;
  videoFrame: boolean;
  encodedVideoChunk: boolean;
} {
  if (!isBrowser()) {
    return {
      videoEncoder: false,
      videoDecoder: false,
      videoFrame: false,
      encodedVideoChunk: false,
    };
  }

  return {
    videoEncoder: typeof VideoEncoder !== 'undefined',
    videoDecoder: typeof VideoDecoder !== 'undefined',
    videoFrame: typeof VideoFrame !== 'undefined',
    encodedVideoChunk: typeof EncodedVideoChunk !== 'undefined',
  };
}

// Test codec support with multiple profiles
async function testCodecSupport(
  codec: string,
  profile?: string
): Promise<{ supported: boolean; hardwareAcceleration: string | null }> {
  if (!isBrowser() || typeof VideoEncoder === 'undefined') {
    return { supported: false, hardwareAcceleration: null };
  }

  try {
    const config: VideoEncoderConfig = {
      codec,
      width: 1280,
      height: 720,
      bitrate: 2_000_000,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
    };

    if (profile && codec.startsWith('avc1')) {
      // For H.264, specify the profile
      (config as VideoEncoderConfig & { avc?: { format: string; profile?: string } }).avc = {
        format: 'avc',
        profile,
      };
    }

    const support = await VideoEncoder.isConfigSupported(config);
    
    return {
      supported: Boolean(support.supported),
      hardwareAcceleration: (support.config as VideoEncoderConfig)?.hardwareAcceleration ?? null,
    };
  } catch (error) {
    console.error('[WebCodecs] Codec test error:', error);
    return { supported: false, hardwareAcceleration: null };
  }
}

// Main function to check WebCodecs support
export async function checkWebCodecsSupport(): Promise<WebCodecsSupport> {
  const capabilities = await getWebCodecsCapabilities();
  
  // Map failure reason to ConverterSupportReason
  let reason: ConverterSupportReason | null = null;
  if (capabilities.failureReason) {
    if (!capabilities.videoEncoder || !capabilities.videoDecoder || !capabilities.videoFrame) {
      reason = 'WEB_CODECS_API_UNAVAILABLE';
    } else if (!capabilities.h264Supported) {
      reason = 'H264_ENCODER_UNSUPPORTED';
    } else {
      reason = 'WEB_CODECS_CHECK_FAILED';
    }
  }
  
  return {
    checking: false,
    supported: capabilities.h264Supported,
    reason,
    details: {
      hasVideoDecoder: capabilities.videoDecoder,
      hasVideoEncoder: capabilities.videoEncoder,
      hasVideoFrame: capabilities.videoFrame,
      hasEncodedVideoChunk: capabilities.videoFrame, // Approximate
      h264Supported: capabilities.h264Supported,
      hardwareAcceleration: capabilities.hardwareAcceleration,
    },
  };
}

// Get detailed capabilities report
export async function getWebCodecsCapabilities(): Promise<WebCodecsCapabilities> {
  // Initialize with defaults
  const result: WebCodecsCapabilities = {
    secureContext: false,
    videoEncoder: false,
    videoDecoder: false,
    videoFrame: false,
    mediaRecorder: false,
    h264Supported: false,
    h264BaselineSupported: false,
    testedCodec: 'avc1.64001f',
    testedProfile: 'High',
    testedLevel: '3.1',
    hardwareAcceleration: 'unknown',
    failureReason: null,
    errorDetails: null,
  };

  // Check browser environment
  if (!isBrowser()) {
    result.failureReason = 'NOT_IN_BROWSER';
    result.errorDetails = 'Function called outside browser environment';
    return result;
  }

  // Check secure context
  result.secureContext = isSecureContext();
  if (!result.secureContext) {
    result.failureReason = 'INSECURE_CONTEXT';
    result.errorDetails = 'WebCodecs requires HTTPS or localhost';
    return result;
  }

  // Detect WebCodecs APIs
  const apis = detectWebCodecsAPIs();
  result.videoEncoder = apis.videoEncoder;
  result.videoDecoder = apis.videoDecoder;
  result.videoFrame = apis.videoFrame;
  
  // Check MediaRecorder (for comparison)
  result.mediaRecorder = typeof MediaRecorder !== 'undefined';

  // Check if all required APIs are available
  if (!apis.videoEncoder || !apis.videoDecoder || !apis.videoFrame) {
    const missing: string[] = [];
    if (!apis.videoEncoder) missing.push('VideoEncoder');
    if (!apis.videoDecoder) missing.push('VideoDecoder');
    if (!apis.videoFrame) missing.push('VideoFrame');
    
    result.failureReason = 'MISSING_APIS';
    result.errorDetails = `Missing APIs: ${missing.join(', ')}`;
    return result;
  }

  // Test H.264 High Profile support first
  const highProfile = await testCodecSupport('avc1.64001f', 'high');
  
  if (highProfile.supported) {
    result.h264Supported = true;
    result.h264BaselineSupported = true;
    result.hardwareAcceleration = highProfile.hardwareAcceleration ?? 'allowed';
    result.failureReason = null;
    result.errorDetails = null;
    return result;
  }

  // Try H.264 Baseline Profile if High Profile not supported
  const baselineProfile = await testCodecSupport('avc1.42E01e', 'baseline');
  
  if (baselineProfile.supported) {
    result.h264Supported = true;
    result.h264BaselineSupported = true;
    result.testedCodec = 'avc1.42E01e';
    result.testedProfile = 'Baseline';
    result.hardwareAcceleration = baselineProfile.hardwareAcceleration ?? 'allowed';
    result.failureReason = null;
    result.errorDetails = null;
    return result;
  }

  // Try Main Profile
  const mainProfile = await testCodecSupport('avc1.4D401f', 'main');
  
  if (mainProfile.supported) {
    result.h264Supported = true;
    result.h264BaselineSupported = false;
    result.testedCodec = 'avc1.4D401f';
    result.testedProfile = 'Main';
    result.hardwareAcceleration = mainProfile.hardwareAcceleration ?? 'allowed';
    result.failureReason = null;
    result.errorDetails = null;
    return result;
  }

  // Try simple H.264 without specific profile
  const simpleTest = await testCodecSupport('avc1.64001f');
  
  if (simpleTest.supported) {
    result.h264Supported = true;
    result.h264BaselineSupported = false;
    result.hardwareAcceleration = simpleTest.hardwareAcceleration ?? 'allowed';
    result.failureReason = null;
    result.errorDetails = null;
    return result;
  }

  // H.264 not supported
  result.h264Supported = false;
  result.failureReason = 'H264_NOT_SUPPORTED';
  result.errorDetails = 'H.264 encoding is not supported by this browser/device';
  return result;
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
      return 'Tarayıcınız WebCodecs uyumluluğu kontrol edilemedi. FFmpeg WebAssembly yöntemini kullanabilirsiniz.';
    case 'FFMPEG_UNAVAILABLE':
      return 'Bu tarayıcı FFmpeg WebAssembly için gerekli özellikleri desteklemiyor.';
    default:
      return null;
  }
}

// Failure reason descriptions
export function getFailureDescription(
  reason: string | null,
  errorDetails: string | null
): string | null {
  if (!reason) return null;

  const descriptions: Record<string, string> = {
    NOT_IN_BROWSER: 'Tarayıcı ortamında çalışmıyor',
    INSECURE_CONTEXT: 'WebCodecs için güvenli bağlantı (HTTPS) gerekli',
    MISSING_APIS: `Eksik API'ler: ${errorDetails || 'bilinmiyor'}`,
    H264_NOT_SUPPORTED: `H.264 kodlama desteklenmiyor. ${errorDetails || ''}`,
  };

  return descriptions[reason] || errorDetails || 'Bilinmeyen hata';
}
