// WebCodecs Support Check with timeout and detailed logging

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
  detectionTimeMs: number | null;
  timedOut: boolean;
}

// Timeout in milliseconds
const DETECTION_TIMEOUT_MS = 3000;

// Singleton to cache results (run detection only once)
let cachedCapabilities: WebCodecsCapabilities | null = null;
let detectionInProgress: Promise<WebCodecsCapabilities> | null = null;

function log(message: string, data?: unknown): void {
  console.log(`[WebCodecs] ${message}`, data ?? '');
}

function logError(message: string, error?: unknown): void {
  console.error(`[WebCodecs] ${message}`, error ?? '');
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

  const result = {
    videoEncoder: typeof VideoEncoder !== 'undefined',
    videoDecoder: typeof VideoDecoder !== 'undefined',
    videoFrame: typeof VideoFrame !== 'undefined',
    encodedVideoChunk: typeof EncodedVideoChunk !== 'undefined',
  };
  
  log('APIs detected', result);
  return result;
}

// Test codec support with timeout and logging
async function testCodecSupport(
  codec: string,
  profile?: string
): Promise<{ supported: boolean; hardwareAcceleration: string | null }> {
  if (!isBrowser() || typeof VideoEncoder === 'undefined') {
    log(`testCodecSupport: VideoEncoder not available`);
    return { supported: false, hardwareAcceleration: null };
  }

  try {
    const profileLabel = profile ? `${profile} profile` : 'default';
    log(`Testing codec ${codec} (${profileLabel})...`);

    const config: VideoEncoderConfig = {
      codec,
      width: 1280,
      height: 720,
      bitrate: 2_000_000,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
    };

    if (profile && codec.startsWith('avc1')) {
      (config as VideoEncoderConfig & { avc?: { format: string; profile?: string } }).avc = {
        format: 'avc',
        profile,
      };
    }

    const support = await VideoEncoder.isConfigSupported(config);
    const supported = Boolean(support.supported);
    
    log(`Codec ${codec} (${profileLabel}): ${supported ? 'SUPPORTED' : 'NOT SUPPORTED'}`,
      supported ? { hardwareAcceleration: support.config?.hardwareAcceleration } : null
    );
    
    return {
      supported,
      hardwareAcceleration: (support.config as VideoEncoderConfig)?.hardwareAcceleration ?? null,
    };
  } catch (error) {
    logError(`Codec ${codec} test failed:`, error);
    return { supported: false, hardwareAcceleration: null };
  }
}

// Create timeout promise
function createTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Detection timeout after ${ms}ms`));
    }, ms);
  });
}

// Get detailed capabilities report with timeout
async function getWebCodecsCapabilitiesInternal(): Promise<WebCodecsCapabilities> {
  const startTime = Date.now();
  
  log('Detection started');
  
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
    detectionTimeMs: null,
    timedOut: false,
  };

  try {
    // Check browser environment
    if (!isBrowser()) {
      result.failureReason = 'NOT_IN_BROWSER';
      result.errorDetails = 'Function called outside browser environment';
      logError('Not in browser environment');
      return result;
    }

    // Check secure context
    result.secureContext = isSecureContext();
    log(`Secure context: ${result.secureContext}`);
    
    if (!result.secureContext) {
      result.failureReason = 'INSECURE_CONTEXT';
      result.errorDetails = 'WebCodecs requires HTTPS or localhost';
      logError('Insecure context');
      return result;
    }

    // Detect WebCodecs APIs
    log('Checking APIs...');
    const apis = detectWebCodecsAPIs();
    result.videoEncoder = apis.videoEncoder;
    result.videoDecoder = apis.videoDecoder;
    result.videoFrame = apis.videoFrame;
    
    // Check MediaRecorder (for comparison)
    result.mediaRecorder = typeof MediaRecorder !== 'undefined';
    log(`APIs: Encoder=${apis.videoEncoder}, Decoder=${apis.videoDecoder}, Frame=${apis.videoFrame}`);

    // Check if all required APIs are available
    if (!apis.videoEncoder || !apis.videoDecoder || !apis.videoFrame) {
      const missing: string[] = [];
      if (!apis.videoEncoder) missing.push('VideoEncoder');
      if (!apis.videoDecoder) missing.push('VideoDecoder');
      if (!apis.videoFrame) missing.push('VideoFrame');
      
      result.failureReason = 'MISSING_APIS';
      result.errorDetails = `Missing APIs: ${missing.join(', ')}`;
      logError(`Missing APIs: ${missing.join(', ')}`);
      return result;
    }

    // Test H.264 profiles
    log('Starting codec tests...');
    
    // Test H.264 High Profile
    log('Testing High Profile (avc1.64001f)...');
    const highProfile = await testCodecSupport('avc1.64001f', 'high');
    
    if (highProfile.supported) {
      result.h264Supported = true;
      result.h264BaselineSupported = true;
      result.hardwareAcceleration = highProfile.hardwareAcceleration ?? 'allowed';
      result.failureReason = null;
      result.errorDetails = null;
      result.detectionTimeMs = Date.now() - startTime;
      log(`High Profile supported! Total time: ${result.detectionTimeMs}ms`);
      return result;
    }

    // Try Baseline Profile
    log('Testing Baseline Profile (avc1.42E01e)...');
    const baselineProfile = await testCodecSupport('avc1.42E01e', 'baseline');
    
    if (baselineProfile.supported) {
      result.h264Supported = true;
      result.h264BaselineSupported = true;
      result.testedCodec = 'avc1.42E01e';
      result.testedProfile = 'Baseline';
      result.hardwareAcceleration = baselineProfile.hardwareAcceleration ?? 'allowed';
      result.failureReason = null;
      result.errorDetails = null;
      result.detectionTimeMs = Date.now() - startTime;
      log(`Baseline Profile supported! Total time: ${result.detectionTimeMs}ms`);
      return result;
    }

    // Try Main Profile
    log('Testing Main Profile (avc1.4D401f)...');
    const mainProfile = await testCodecSupport('avc1.4D401f', 'main');
    
    if (mainProfile.supported) {
      result.h264Supported = true;
      result.h264BaselineSupported = false;
      result.testedCodec = 'avc1.4D401f';
      result.testedProfile = 'Main';
      result.hardwareAcceleration = mainProfile.hardwareAcceleration ?? 'allowed';
      result.failureReason = null;
      result.errorDetails = null;
      result.detectionTimeMs = Date.now() - startTime;
      log(`Main Profile supported! Total time: ${result.detectionTimeMs}ms`);
      return result;
    }

    // Try simple H.264 without specific profile
    log('Testing default H.264...');
    const simpleTest = await testCodecSupport('avc1.64001f');
    
    if (simpleTest.supported) {
      result.h264Supported = true;
      result.h264BaselineSupported = false;
      result.hardwareAcceleration = simpleTest.hardwareAcceleration ?? 'allowed';
      result.failureReason = null;
      result.errorDetails = null;
      result.detectionTimeMs = Date.now() - startTime;
      log(`Default H.264 supported! Total time: ${result.detectionTimeMs}ms`);
      return result;
    }

    // H.264 not supported
    result.h264Supported = false;
    result.failureReason = 'H264_NOT_SUPPORTED';
    result.errorDetails = 'H.264 encoding is not supported by this browser/device';
    result.detectionTimeMs = Date.now() - startTime;
    logError(`H.264 not supported. Total time: ${result.detectionTimeMs}ms`);
    return result;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.failureReason = 'DETECTION_ERROR';
    result.errorDetails = errorMessage;
    result.detectionTimeMs = Date.now() - startTime;
    logError(`Detection failed: ${errorMessage}. Total time: ${result.detectionTimeMs}ms`);
    return result;
  }
}

// Get detailed capabilities report with timeout protection
export async function getWebCodecsCapabilities(): Promise<WebCodecsCapabilities> {
  // Return cached result if available
  if (cachedCapabilities) {
    log('Returning cached capabilities');
    return cachedCapabilities;
  }

  // If detection is already in progress, wait for it
  if (detectionInProgress) {
    log('Waiting for detection in progress...');
    return detectionInProgress;
  }

  // Start new detection with timeout
  log(`Starting detection with ${DETECTION_TIMEOUT_MS}ms timeout...`);
  
  detectionInProgress = Promise.race([
    getWebCodecsCapabilitiesInternal(),
    createTimeout(DETECTION_TIMEOUT_MS).then(() => {
      // Return timeout result
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
        failureReason: 'TIMEOUT',
        errorDetails: `WebCodecs detection timed out after ${DETECTION_TIMEOUT_MS}ms`,
        detectionTimeMs: DETECTION_TIMEOUT_MS,
        timedOut: true,
      };
      logError(`Detection TIMEOUT after ${DETECTION_TIMEOUT_MS}ms`);
      return result;
    }),
  ]).finally(() => {
    detectionInProgress = null;
  });

  const result = await detectionInProgress;
  cachedCapabilities = result;
  log(`Detection complete. Time: ${result.detectionTimeMs}ms, Supported: ${result.h264Supported}`);
  return result;
}

// Reset cache (for testing)
export function resetWebCodecsCache(): void {
  cachedCapabilities = null;
  detectionInProgress = null;
  log('Cache reset');
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
      hasEncodedVideoChunk: capabilities.videoFrame,
      h264Supported: capabilities.h264Supported,
      hardwareAcceleration: capabilities.hardwareAcceleration,
    },
  };
}

export function checkFFmpegSupport(): ConverterSupport {
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
    TIMEOUT: `Tespit süresi aşıldı. ${errorDetails || ''}`,
    DETECTION_ERROR: `Tespit hatası. ${errorDetails || ''}`,
  };

  return descriptions[reason] || errorDetails || 'Bilinmeyen hata';
}
