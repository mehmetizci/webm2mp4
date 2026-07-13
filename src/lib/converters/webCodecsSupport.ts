// WebCodecs Support Check with detection IDs and stale result prevention

import type { WebCodecsSupport, ConverterSupport, ConverterSupportReason } from './types';

export interface CodecTestResult {
  codec: string;
  profile: string;
  supported: boolean | null; // null = not tested yet
  hardwareAcceleration: string | null;
}

export interface WebCodecsCapabilities {
  detectionId: string;
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
  codecResults: CodecTestResult[];
}

// Timeout in milliseconds
const DETECTION_TIMEOUT_MS = 3000;

// Generate unique detection ID
let globalDetectionCounter = 0;
let cachedCapabilities: WebCodecsCapabilities | null = null;
let currentDetectionId: string | null = null;

function generateDetectionId(): string {
  globalDetectionCounter++;
  return `detection-${Date.now()}-${globalDetectionCounter}`;
}

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
  return window.isSecureContext ?? true;
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

// Test codec support
async function testCodecSupport(
  detectionId: string,
  codec: string,
  profile: string
): Promise<{ codec: string; profile: string; supported: boolean; hardwareAcceleration: string | null }> {
  if (!isBrowser() || typeof VideoEncoder === 'undefined') {
    log(`[${detectionId}] VideoEncoder not available`);
    return { codec, profile, supported: false, hardwareAcceleration: null };
  }

  try {
    log(`[${detectionId}] Testing ${codec} (${profile})...`);

    const config: VideoEncoderConfig = {
      codec,
      width: 1280,
      height: 720,
      bitrate: 2_000_000,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
    };

    if (codec.startsWith('avc1')) {
      (config as VideoEncoderConfig & { avc?: { format: string; profile?: string } }).avc = {
        format: 'avc',
        profile: profile.toLowerCase(),
      };
    }

    const support = await VideoEncoder.isConfigSupported(config);
    const supported = Boolean(support.supported);
    
    log(`[${detectionId}] ${codec} (${profile}): ${supported ? 'SUPPORTED' : 'NOT SUPPORTED'}`);
    
    return {
      codec,
      profile,
      supported,
      hardwareAcceleration: (support.config as VideoEncoderConfig)?.hardwareAcceleration ?? null,
    };
  } catch (error) {
    logError(`[${detectionId}] ${codec} test failed:`, error);
    return { codec, profile, supported: false, hardwareAcceleration: null };
  }
}

// Get detailed capabilities report
async function getWebCodecsCapabilitiesInternal(detectionId: string): Promise<WebCodecsCapabilities> {
  const startTime = Date.now();
  
  log(`[${detectionId}] Detection started`);
  
  // Initialize codec results tracking
  const codecResults: CodecTestResult[] = [
    { codec: 'avc1.64001f', profile: 'High', supported: null, hardwareAcceleration: null },
    { codec: 'avc1.42E01e', profile: 'Baseline', supported: null, hardwareAcceleration: null },
    { codec: 'avc1.4D401f', profile: 'Main', supported: null, hardwareAcceleration: null },
  ];

  const result: WebCodecsCapabilities = {
    detectionId,
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
    codecResults,
  };

  try {
    // Check browser environment
    if (!isBrowser()) {
      result.failureReason = 'NOT_IN_BROWSER';
      result.errorDetails = 'Function called outside browser environment';
      logError(`[${detectionId}] Not in browser environment`);
      return result;
    }

    // Check secure context
    result.secureContext = isSecureContext();
    log(`[${detectionId}] Secure context: ${result.secureContext}`);
    
    if (!result.secureContext) {
      result.failureReason = 'INSECURE_CONTEXT';
      result.errorDetails = 'WebCodecs requires HTTPS or localhost';
      logError(`[${detectionId}] Insecure context`);
      return result;
    }

    // Detect WebCodecs APIs
    log(`[${detectionId}] Checking APIs...`);
    const apis = detectWebCodecsAPIs();
    result.videoEncoder = apis.videoEncoder;
    result.videoDecoder = apis.videoDecoder;
    result.videoFrame = apis.videoFrame;
    result.mediaRecorder = typeof MediaRecorder !== 'undefined';
    log(`[${detectionId}] APIs: Encoder=${apis.videoEncoder}, Decoder=${apis.videoDecoder}, Frame=${apis.videoFrame}`);

    // Check if all required APIs are available
    if (!apis.videoEncoder || !apis.videoDecoder || !apis.videoFrame) {
      const missing: string[] = [];
      if (!apis.videoEncoder) missing.push('VideoEncoder');
      if (!apis.videoDecoder) missing.push('VideoDecoder');
      if (!apis.videoFrame) missing.push('VideoFrame');
      
      result.failureReason = 'MISSING_APIS';
      result.errorDetails = `Missing APIs: ${missing.join(', ')}`;
      logError(`[${detectionId}] Missing APIs: ${missing.join(', ')}`);
      return result;
    }

    // Test all codec profiles and track results
    log(`[${detectionId}] Starting codec tests...`);
    
    // Test High Profile
    const highResult = await testCodecSupport(detectionId, 'avc1.64001f', 'High');
    codecResults[0] = { 
      codec: highResult.codec, 
      profile: highResult.profile, 
      supported: highResult.supported, 
      hardwareAcceleration: highResult.hardwareAcceleration 
    };
    
    if (highResult.supported) {
      result.h264Supported = true;
      result.h264BaselineSupported = true;
      result.testedCodec = highResult.codec;
      result.testedProfile = 'High';
      result.hardwareAcceleration = highResult.hardwareAcceleration ?? 'allowed';
      result.detectionTimeMs = Date.now() - startTime;
      log(`[${detectionId}] High Profile supported! Time: ${result.detectionTimeMs}ms`);
      return result;
    }

    // Test Baseline Profile
    const baselineResult = await testCodecSupport(detectionId, 'avc1.42E01e', 'Baseline');
    codecResults[1] = { 
      codec: baselineResult.codec, 
      profile: baselineResult.profile, 
      supported: baselineResult.supported, 
      hardwareAcceleration: baselineResult.hardwareAcceleration 
    };
    
    if (baselineResult.supported) {
      result.h264Supported = true;
      result.h264BaselineSupported = true;
      result.testedCodec = baselineResult.codec;
      result.testedProfile = 'Baseline';
      result.hardwareAcceleration = baselineResult.hardwareAcceleration ?? 'allowed';
      result.detectionTimeMs = Date.now() - startTime;
      log(`[${detectionId}] Baseline Profile supported! Time: ${result.detectionTimeMs}ms`);
      return result;
    }

    // Test Main Profile
    const mainResult = await testCodecSupport(detectionId, 'avc1.4D401f', 'Main');
    codecResults[2] = { 
      codec: mainResult.codec, 
      profile: mainResult.profile, 
      supported: mainResult.supported, 
      hardwareAcceleration: mainResult.hardwareAcceleration 
    };
    
    if (mainResult.supported) {
      result.h264Supported = true;
      result.h264BaselineSupported = false;
      result.testedCodec = mainResult.codec;
      result.testedProfile = 'Main';
      result.hardwareAcceleration = mainResult.hardwareAcceleration ?? 'allowed';
      result.detectionTimeMs = Date.now() - startTime;
      log(`[${detectionId}] Main Profile supported! Time: ${result.detectionTimeMs}ms`);
      return result;
    }

    // H.264 not supported - all tested
    result.h264Supported = false;
    result.failureReason = 'H264_NOT_SUPPORTED';
    result.errorDetails = 'H.264 encoding is not supported by this browser/device';
    result.detectionTimeMs = Date.now() - startTime;
    logError(`[${detectionId}] H.264 not supported. All codecs tested. Time: ${result.detectionTimeMs}ms`);
    return result;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.failureReason = 'DETECTION_ERROR';
    result.errorDetails = errorMessage;
    result.detectionTimeMs = Date.now() - startTime;
    logError(`[${detectionId}] Detection failed: ${errorMessage}. Time: ${result.detectionTimeMs}ms`);
    return result;
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

// Get detailed capabilities report with timeout protection
export async function getWebCodecsCapabilities(): Promise<WebCodecsCapabilities> {
  const detectionId = generateDetectionId();
  currentDetectionId = detectionId;
  
  log(`[${detectionId}] Starting detection with ${DETECTION_TIMEOUT_MS}ms timeout...`);
  
  // Race between detection and timeout
  const detectionPromise = getWebCodecsCapabilitiesInternal(detectionId);
  const timeoutPromise = createTimeout(DETECTION_TIMEOUT_MS);
  
  try {
    // Use Promise.race but always return the detection result
    const result = await Promise.race([
      detectionPromise,
      timeoutPromise.then(() => {
        // This won't actually resolve, will be caught by race
        throw new Error('Timeout');
      }),
    ]).catch((error) => {
      // Check if this is our timeout or a real error
      if (error.message.includes('Timeout')) {
        logError(`[${detectionId}] Detection TIMEOUT after ${DETECTION_TIMEOUT_MS}ms`);
        return {
          detectionId,
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
          codecResults: [
            { codec: 'avc1.64001f', profile: 'High', supported: null, hardwareAcceleration: null },
            { codec: 'avc1.42E01e', profile: 'Baseline', supported: null, hardwareAcceleration: null },
            { codec: 'avc1.4D401f', profile: 'Main', supported: null, hardwareAcceleration: null },
          ],
        } as WebCodecsCapabilities;
      }
      throw error;
    });
    
    // Only cache successful results, not timeouts
    if (!result.timedOut && result.failureReason !== 'TIMEOUT') {
      cachedCapabilities = result;
      log(`[${detectionId}] Cached successful result`);
    } else {
      log(`[${detectionId}] Timeout result NOT cached`);
    }
    
    log(`[${detectionId}] Detection complete. Time: ${result.detectionTimeMs}ms, Supported: ${result.h264Supported}`);
    return result;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(`[${detectionId}] Detection error: ${errorMessage}`);
    
    return {
      detectionId,
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
      failureReason: 'DETECTION_ERROR',
      errorDetails: errorMessage,
      detectionTimeMs: null,
      timedOut: false,
      codecResults: [
        { codec: 'avc1.64001f', profile: 'High', supported: null, hardwareAcceleration: null },
        { codec: 'avc1.42E01e', profile: 'Baseline', supported: null, hardwareAcceleration: null },
        { codec: 'avc1.4D401f', profile: 'Main', supported: null, hardwareAcceleration: null },
      ],
    };
  } finally {
    if (currentDetectionId === detectionId) {
      currentDetectionId = null;
    }
  }
}

// Check if detection is stale (another detection has started)
export function isDetectionStale(detectionId: string): boolean {
  return currentDetectionId !== null && currentDetectionId !== detectionId;
}

// Reset cache (for manual retry)
export function resetWebCodecsCache(): void {
  cachedCapabilities = null;
  currentDetectionId = null;
  log('Cache reset');
}

// Get current detection ID
export function getCurrentDetectionId(): string | null {
  return currentDetectionId;
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
    H264_NOT_SUPPORTED: 'H.264 kodlama desteklenmiyor',
    TIMEOUT: `Tespit süresi aşıldı (${DETECTION_TIMEOUT_MS}ms)`,
    DETECTION_ERROR: `Tespit hatası: ${errorDetails || ''}`,
  };

  return descriptions[reason] || errorDetails || 'Bilinmeyen hata';
}

// ============================================================================
// Encoder Config Optimization Utilities
// ============================================================================

export type H264Profile = 'Baseline' | 'Main' | 'High';

export interface EncoderConfigTestResult {
  codec: string;
  hardwareAcceleration: 'prefer-hardware' | 'no-preference' | 'prefer-software';
  supported: boolean;
  actualHardwareAcceleration: string | null;
}

export interface BitrateModeTestResult {
  mode: 'constant' | 'variable';
  supported: boolean;
}

// Test a specific encoder config for compatibility
export async function testEncoderConfig(
  codec: string,
  width: number,
  height: number,
  framerate: number,
  bitrate: number,
  hardwareAcceleration: 'prefer-hardware' | 'no-preference' | 'prefer-software'
): Promise<EncoderConfigTestResult> {
  if (!isBrowser() || typeof VideoEncoder === 'undefined') {
    return { codec, hardwareAcceleration, supported: false, actualHardwareAcceleration: null };
  }

  try {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate,
      hardwareAcceleration,
    };

    // Add profile for H.264 codecs
    if (codec.startsWith('avc1.')) {
      const profileMap: Record<string, string> = {
        'avc1.64001f': 'high',
        'avc1.4D401f': 'main',
        'avc1.42E01e': 'baseline',
      };
      const profile = profileMap[codec] || 'high';
      (config as VideoEncoderConfig & { avc?: { format: string; profile?: string } }).avc = {
        format: 'avc',
        profile,
      };
    }

    const support = await VideoEncoder.isConfigSupported(config);
    return {
      codec,
      hardwareAcceleration,
      supported: Boolean(support.supported),
      actualHardwareAcceleration: (support.config as VideoEncoderConfig)?.hardwareAcceleration ?? null,
    };
  } catch (error) {
    logError('testEncoderConfig failed:', error);
    return { codec, hardwareAcceleration, supported: false, actualHardwareAcceleration: null };
  }
}

// Find the best encoder config for a given resolution/bitrate
// Priority order ensures High+no-preference (known working config) is always tried
// Also tests prefer-hardware variants first, but falls back to no-preference
export async function findBestEncoderConfig(
  width: number,
  height: number,
  framerate: number,
  bitrate: number,
  preferVariableBitrate: boolean = false
): Promise<{
  codec: string;
  hardwareAcceleration: 'prefer-hardware' | 'no-preference';
  bitrateMode: 'constant' | 'variable';
}> {
  // Priority order: Try prefer-hardware first (faster if supported), then no-preference
  // Within each HW mode, try profiles in order: High (most compatible), Main, Baseline
  // This ensures High+no-preference (known working config) is always tested
  const priorityOrder: Array<{
    codec: string;
    profile: string;
    hwMode: 'prefer-hardware' | 'no-preference';
  }> = [
    // First try prefer-hardware variants (faster if supported)
    { codec: 'avc1.64001f', profile: 'High', hwMode: 'prefer-hardware' },
    { codec: 'avc1.4D401f', profile: 'Main', hwMode: 'prefer-hardware' },
    { codec: 'avc1.42E01e', profile: 'Baseline', hwMode: 'prefer-hardware' },
    // Then try no-preference variants (more compatible)
    { codec: 'avc1.64001f', profile: 'High', hwMode: 'no-preference' },
    { codec: 'avc1.4D401f', profile: 'Main', hwMode: 'no-preference' },
    { codec: 'avc1.42E01e', profile: 'Baseline', hwMode: 'no-preference' },
  ];

  // Test configs in priority order
  for (const { codec, profile, hwMode } of priorityOrder) {
    log(`Testing config: ${profile}+${hwMode} (${codec})`);
    
    const result = await testEncoderConfig(codec, width, height, framerate, bitrate, hwMode);
    
    if (result.supported) {
      log(`Config supported: ${profile}+${hwMode}`);
      
      // Test bitrate mode if requested
      if (preferVariableBitrate) {
        const varResult = await testBitrateMode(codec, width, height, framerate, bitrate, hwMode, 'variable');
        if (varResult.supported) {
          const finalConfig = { codec, hardwareAcceleration: hwMode, bitrateMode: 'variable' as const };
          log(`[ENCODER_CONFIG_STEP_1] findBestEncoderConfig() returning: codec=${finalConfig.codec}, hardwareAcceleration=${finalConfig.hardwareAcceleration}, bitrateMode=${finalConfig.bitrateMode}, bitrate=${bitrate}, width=${width}, height=${height}, framerate=${framerate}`);
          return finalConfig;
        }
      }
      
      const finalConfig = { codec, hardwareAcceleration: hwMode, bitrateMode: 'constant' as const };
      log(`[ENCODER_CONFIG_STEP_1] findBestEncoderConfig() returning: codec=${finalConfig.codec}, hardwareAcceleration=${finalConfig.hardwareAcceleration}, bitrateMode=${finalConfig.bitrateMode}, bitrate=${bitrate}, width=${width}, height=${height}, framerate=${framerate}`);
      return finalConfig;
    } else {
      log(`Config NOT supported: ${profile}+${hwMode}`);
    }
  }

  // Fallback to known working config (High + no-preference + constant)
  // This should always work on devices with WebCodecs support
  log('No optimized config found, using known working fallback: High+no-preference+constant');
  const fallbackConfig = {
    codec: 'avc1.64001f',
    hardwareAcceleration: 'no-preference' as const,
    bitrateMode: 'constant' as const,
  };
  log(`[ENCODER_CONFIG_STEP_1] findBestEncoderConfig() FALLBACK returning: codec=${fallbackConfig.codec}, hardwareAcceleration=${fallbackConfig.hardwareAcceleration}, bitrateMode=${fallbackConfig.bitrateMode}, bitrate=${bitrate}, width=${width}, height=${height}, framerate=${framerate}`);
  return fallbackConfig;
}

// Test bitrate mode support
async function testBitrateMode(
  codec: string,
  width: number,
  height: number,
  framerate: number,
  bitrate: number,
  hardwareAcceleration: 'prefer-hardware' | 'no-preference',
  bitrateMode: 'constant' | 'variable'
): Promise<BitrateModeTestResult> {
  if (!isBrowser() || typeof VideoEncoder === 'undefined') {
    return { mode: bitrateMode, supported: false };
  }

  try {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate,
      hardwareAcceleration,
      bitrateMode,
    };

    // Add profile for H.264 codecs
    if (codec.startsWith('avc1.')) {
      const profileMap: Record<string, string> = {
        'avc1.64001f': 'high',
        'avc1.4D401f': 'main',
        'avc1.42E01e': 'baseline',
      };
      const profile = profileMap[codec] || 'high';
      (config as VideoEncoderConfig & { avc?: { format: string; profile?: string } }).avc = {
        format: 'avc',
        profile,
      };
    }

    const support = await VideoEncoder.isConfigSupported(config);
    return {
      mode: bitrateMode,
      supported: Boolean(support.supported),
    };
  } catch (error) {
    logError('testBitrateMode failed:', error);
    return { mode: bitrateMode, supported: false };
  }
}
