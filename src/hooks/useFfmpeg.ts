'use client';

import { useCallback, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { 
  ConversionProgress, 
  ConversionResult, 
  ConversionError,
  QualityPreset,
  ConversionStage,
} from '@/types/converter';
import { getOutputFileName } from '@/lib/file-utils';

// FFmpeg engine types
export type FFmpegEngineType = 'multi-thread' | 'single-thread';

// Generate unique file names for each conversion job
function generateInputFileName(jobId: string): string {
  return `input-${jobId}.webm`;
}

function generateOutputFileName(jobId: string): string {
  return `output-${jobId}.mp4`;
}

// Generate unique job ID
function generateJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Fallback constants for cleanup when job ID is not available
const INPUT_FILE = 'input.webm';
const OUTPUT_FILE = 'output.mp4';

// Timeout values
const STALL_TIMEOUT_MS = 90000; // 90 seconds stall detection - activity-based
const MAX_EXECUTION_TIME_MS = 30 * 60 * 1000; // 30 minutes absolute safety limit
const DUPLICATE_FRAME_WARNING_THRESHOLD = 100;
const DUPLICATE_FRAME_ABORT_THRESHOLD = 1000;

// SharedArrayBuffer detection for multi-threading support
function checkSharedArrayBufferSupport(): { 
  available: boolean; 
  crossOriginIsolated: boolean 
} {
  const crossOriginIsolated = typeof window !== 'undefined' 
    ? (window as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? false
    : false;
  
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  
  return {
    available: crossOriginIsolated && hasSharedArrayBuffer,
    crossOriginIsolated,
  };
}

// Get CPU core count from navigator.hardwareConcurrency
function getCPUCores(): number {
  if (typeof navigator !== 'undefined' && 'hardwareConcurrency' in navigator) {
    return navigator.hardwareConcurrency ?? 2;
  }
  return 2; // Default fallback
}

// Determine optimal thread count based on CPU cores and multi-threading support
// Rules:
// - Multi-Thread requires: crossOriginIsolated=true, SharedArrayBuffer available, core-mt loaded
// - If MT available and hardwareConcurrency <= 2: threads = 2
// - If MT available and hardwareConcurrency >= 4: threads = 4 (max)
// - If MT not available (single-thread fallback): threads = 1
function determineThreadCount(
  isMultiThreadSupported: boolean,
  cpuCores: number
): { threads: number; engineType: FFmpegEngineType; reason: string } {
  if (isMultiThreadSupported) {
    if (cpuCores <= 2) {
      return { threads: 2, engineType: 'multi-thread', reason: `MT + ${cpuCores} cores → 2 threads` };
    } else {
      // cpuCores >= 4, cap at 4 threads maximum
      return { threads: 4, engineType: 'multi-thread', reason: `MT + ${cpuCores} cores → 4 threads (max)` };
    }
  } else {
    return { threads: 1, engineType: 'single-thread', reason: `Single-Thread fallback → 1 thread` };
  }
}

// Create a promise that rejects after timeout
function createTimeoutPromise(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

// CDN URLs for FFmpeg cores - both at 0.12.10
const CORE_MT_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/umd';
const CORE_ST_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';

// Local fallback paths (same-origin)
const CORE_MT_LOCAL = '/ffmpeg/core-mt';
const CORE_ST_LOCAL = '/ffmpeg';

// Loading step logging
type LoadingStep = 
  | 'core_js'
  | 'wasm' 
  | 'worker'
  | 'complete'
  | 'timeout'
  | 'network_error'
  | 'unknown_error';

function logLoadingStep(step: LoadingStep, details?: string): string {
  switch (step) {
    case 'core_js':
      return 'Loading core.js...';
    case 'wasm':
      return 'Loading wasm...';
    case 'worker':
      return 'Loading worker...';
    case 'complete':
      return 'Load completed successfully';
    case 'timeout':
      return `Load timeout: ${details || 'unknown'}`;
    case 'network_error':
      return `Network error loading: ${details || 'unknown'}`;
    case 'unknown_error':
      return `Load failed: ${details || 'unknown'}`;
  }
}

// Engine logging helper
function logEngine(message: string): string {
  return `[Engine] ${message}`;
}

// MT loading result types
interface MTLoadResult {
  success: boolean;
  errorMessage?: string;
  cdnAttempted?: boolean;
  cdnSuccess?: boolean;
  localAttempted?: boolean;
  localSuccess?: boolean;
  assetLoadTimes?: {
    core?: number;
    wasm?: number;
    worker?: number;
  };
}

// Helper to load a single asset with timing
async function loadAsset(
  label: string,
  url: string,
  mimeType: string,
  logCallback?: (msg: string) => void,
): Promise<string> {
  const startTime = performance.now();
  
  try {
    logCallback?.(`[MT] ${label} indiriliyor: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const blobData = await response.blob();
    const resultUrl = URL.createObjectURL(blobData);
    
    const elapsed = Math.round(performance.now() - startTime);
    logCallback?.(`[MT] ${label} hazir: ${elapsed}ms`);
    
    return resultUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logCallback?.(`[MT] ${label} hatasi: ${message}`);
    throw new Error(`MT_ASSET_LOAD_FAILED:${label}:${message}`);
  }
}

interface FFmpegLogStats {
  encodedFrame: number | null;
  encodedTime: number | null;
  encodingFps: number | null;
  duplicatedFrames: number | null;
  encodingSpeed: number | null;
}

interface DebugCallbacks {
  addLog?: (level: 'info' | 'success' | 'warning' | 'error', step: string, message: string, details?: unknown) => void;
  updateDebugInfo?: (updates: Record<string, unknown>) => void;
}

interface UseFfmpegReturn {
  isLoaded: boolean;
  isLoading: boolean;
  progress: ConversionProgress;
  error: ConversionError | null;
  loadFFmpeg: () => Promise<boolean>;
  convert: (
    file: File,
    quality: QualityPreset,
    onStageChange?: (stage: ConversionStage) => void,
    videoDuration?: number | null,
    sourceWidth?: number | null,
    sourceHeight?: number | null
  ) => Promise<ConversionResult>;
  terminate: () => void;
}

// Check if device is mobile
function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// Get device memory (in GB)
function getDeviceMemory(): number | null {
  if (typeof navigator !== 'undefined' && 'deviceMemory' in navigator) {
    return (navigator as { deviceMemory?: number }).deviceMemory || null;
  }
  return null;
}

// Parse FFmpeg progress line
function parseFFmpegProgress(line: string): FFmpegLogStats | null {
  const stats: FFmpegLogStats = {
    encodedFrame: null,
    encodedTime: null,
    encodingFps: null,
    duplicatedFrames: null,
    encodingSpeed: null,
  };

  const frameMatch = line.match(/frame=\s*(\d+)/);
  if (frameMatch) stats.encodedFrame = parseInt(frameMatch[1], 10);

  const timeMatch = line.match(/time=\s*(\d{2}):(\d{2}):(\d{2}\.?\d*)/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseFloat(timeMatch[3]);
    stats.encodedTime = hours * 3600 + minutes * 60 + seconds;
  }

  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  if (fpsMatch) stats.encodingFps = parseFloat(fpsMatch[1]);

  const dupMatch = line.match(/dup=\s*(\d+)/);
  if (dupMatch) stats.duplicatedFrames = parseInt(dupMatch[1], 10);

  const speedMatch = line.match(/speed=\s*([\d.]+)x/);
  if (speedMatch) stats.encodingSpeed = parseFloat(speedMatch[1]);

  if (stats.encodedFrame === null && stats.encodedTime === null) {
    return null;
  }

  return stats;
}

export function useFfmpeg(debugCallbacks?: DebugCallbacks): UseFfmpegReturn {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fileDataRef = useRef<Uint8Array | null>(null);
  const logHandlerRef = useRef<((data: { message: string }) => void) | null>(null);
  const progressHandlerRef = useRef<((data: { progress: number }) => void) | null>(null);
  const stallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const lastFFmpegMessageRef = useRef<string>('');
  const lastEncodedTimeRef = useRef<number | null>(null);
  const videoDurationRef = useRef<number | null>(null);
  const maxEncodedTimeRef = useRef<number>(0); // Track max encoded time for FFmpeg fallback
  const hasHtml5MetadataRef = useRef(false); // Track if HTML5 metadata was successful
  const jobIdRef = useRef<string>(''); // Current job ID for unique file names
  const currentInputFileRef = useRef<string>(''); // Current input file name
  const currentOutputFileRef = useRef<string>(''); // Current output file name
  const ffmpegCommandRef = useRef<string[]>([]); // Store the FFmpeg command for debug
  const engineTypeRef = useRef<FFmpegEngineType>('single-thread'); // Current engine type
  const threadCountRef = useRef<number>(1); // Current thread count (MT=2, ST=1)
  const currentLoadIdRef = useRef<number>(0); // Load race condition prevention
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ConversionProgress>({
    percent: 0,
    time: 0,
    stage: 'idle',
    hasProgress: false,
    encodedTime: null,
    encodingSpeed: null,
    totalDuration: null,
  });
  const [error, setError] = useState<ConversionError | null>(null);

  const startTimeRef = useRef<number>(Date.now());

  const { addLog, updateDebugInfo } = debugCallbacks || {};

  const normalizeError = (err: unknown): { message: string; stack: string | null } => {
    if (err instanceof Error) {
      return { message: err.message, stack: err.stack || null };
    }
    return { message: String(err), stack: null };
  };

  const clearAllTimeouts = useCallback(() => {
    if (stallTimeoutRef.current) {
      clearTimeout(stallTimeoutRef.current);
      stallTimeoutRef.current = null;
    }
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
    }
  }, []);

  const updateProgress = useCallback((
    percent: number, 
    stage: ConversionStage, 
    hasProgress = true,
    encodedTime?: number | null,
    encodingSpeed?: number | null,
    totalDuration?: number | null
  ) => {
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    setProgress(prev => ({
      percent: percent >= 0 ? Math.min(percent, 100) : prev.percent,
      time: elapsed,
      stage,
      hasProgress,
      // Safe merge: only update if value is valid, preserve existing
      encodedTime: encodedTime !== undefined && encodedTime !== null && encodedTime >= 0 
        ? encodedTime 
        : prev.encodedTime,
      encodingSpeed: encodingSpeed !== undefined && encodingSpeed !== null 
        ? encodingSpeed 
        : prev.encodingSpeed,
      // Safe merge: totalDuration should never be overwritten with null/0
      totalDuration: totalDuration !== undefined && totalDuration !== null && totalDuration > 0
        ? totalDuration
        : prev.totalDuration,
    }));
  }, []);

  // Reentrant protection - prevents double cleanup
  const cleanupInProgressRef = useRef(false);
  
  // Cleanup validation results
  interface CleanupValidation {
    inputDeleted: boolean;
    outputDeleted: boolean;
    listenersRemoved: boolean;
    timersCleared: boolean;
    workerTerminated: boolean;
    errorDuringCleanup: string | null;
  }

  // Unified cleanup function - handles all cleanup in proper order
  const cleanupResources = useCallback(async (options: {
    terminateWorker: boolean;
    reason?: string;
  }): Promise<CleanupValidation> => {
    const { terminateWorker, reason = 'Unknown' } = options;
    
    // Reentrant protection - prevent double cleanup
    if (cleanupInProgressRef.current) {
      addLog?.('info', 'Cleanup', 'Cleanup already in progress, skipping');
      return {
        inputDeleted: false,
        outputDeleted: false,
        listenersRemoved: false,
        timersCleared: false,
        workerTerminated: false,
        errorDuringCleanup: 'cleanup_in_progress',
      };
    }
    
    cleanupInProgressRef.current = true;
    const cleanupStartTime = Date.now();
    
    const validation: CleanupValidation = {
      inputDeleted: false,
      outputDeleted: false,
      listenersRemoved: false,
      timersCleared: false,
      workerTerminated: false,
      errorDuringCleanup: null,
    };
    
    updateDebugInfo?.({ cleanupStatus: 'cleaning' });
    addLog?.('info', 'Cleanup', `Starting cleanup: terminateWorker=${terminateWorker}, reason=${reason}`);
    
    try {
      const ffmpeg = ffmpegRef.current;
      const inputFileToDelete = currentInputFileRef.current || INPUT_FILE;
      const outputFileToDelete = currentOutputFileRef.current || OUTPUT_FILE;
      
      // Step 1: Clean VFS files FIRST (before terminate)
      // Files must be deleted before worker is terminated
      if (ffmpeg) {
        try {
          await ffmpeg.deleteFile(inputFileToDelete);
          validation.inputDeleted = true;
          addLog?.('info', 'Cleanup', `Input file deleted: ${inputFileToDelete}`);
        } catch {
          // File might not exist - this is OK
          validation.inputDeleted = true; // Consider it cleaned
        }
        
        try {
          await ffmpeg.deleteFile(outputFileToDelete);
          validation.outputDeleted = true;
          addLog?.('info', 'Cleanup', `Output file deleted: ${outputFileToDelete}`);
        } catch {
          // File might not exist - this is OK
          validation.outputDeleted = true; // Consider it cleaned
        }
      }
      
      // Step 2: Remove all listeners
      try {
        if (logHandlerRef.current && ffmpeg) {
          ffmpeg.off('log', logHandlerRef.current);
        }
        if (progressHandlerRef.current && ffmpeg) {
          ffmpeg.off('progress', progressHandlerRef.current);
        }
        logHandlerRef.current = null;
        progressHandlerRef.current = null;
        validation.listenersRemoved = true;
        addLog?.('info', 'Cleanup', 'Listeners removed');
      } catch (e) {
        addLog?.('warning', 'Cleanup', `Listener removal error: ${e}`);
      }
      
      // Step 3: Clear all timers
      try {
        clearAllTimeouts();
        validation.timersCleared = true;
        addLog?.('info', 'Cleanup', 'Timers cleared');
      } catch (e) {
        addLog?.('warning', 'Cleanup', `Timer clearing error: ${e}`);
      }
      
      // Step 4: Terminate worker if needed (LAST step)
      if (terminateWorker && ffmpeg) {
        try {
          ffmpeg.terminate();
          validation.workerTerminated = true;
          addLog?.('info', 'Cleanup', 'Worker terminated');
        } catch (e) {
          addLog?.('warning', 'Cleanup', `Worker terminate error: ${e}`);
        }
        
        // Reset all state after terminate
        ffmpegRef.current = null;
        setIsLoaded(false);
        setProgress({
          percent: 0,
          time: 0,
          stage: 'idle',
          hasProgress: false,
          encodedTime: null,
          encodingSpeed: null,
        });
        updateDebugInfo?.({
          ffmpegExecStatus: 'error',
          ffmpegLoadStatus: 'idle',
        });
      }
      
      // Clear file data reference
      fileDataRef.current = null;
      
      // Calculate cleanup duration
      const cleanupDuration = Date.now() - cleanupStartTime;
      
      // Update debug info with validation results
      updateDebugInfo?.({
        cleanupStatus: 'completed',
        cleanupValidation: validation,
        cleanupDuration,
      });
      
      addLog?.('info', 'Cleanup', `Cleanup completed in ${cleanupDuration}ms`);
      addLog?.('info', 'Cleanup', `Validation: input=${validation.inputDeleted}, output=${validation.outputDeleted}, listeners=${validation.listenersRemoved}, timers=${validation.timersCleared}, terminated=${validation.workerTerminated}`);
      
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      validation.errorDuringCleanup = errorMessage;
      addLog?.('warning', 'Cleanup', `Cleanup error: ${errorMessage}`);
      updateDebugInfo?.({
        cleanupStatus: 'warning',
        cleanupValidation: validation,
      });
    } finally {
      cleanupInProgressRef.current = false;
    }
    
    return validation;
  }, [clearAllTimeouts, updateDebugInfo, addLog]);

  // Pre-cleanup: Remove leftover files before new conversion
  const preCleanup = useCallback(async () => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) return;
    
    // Clean up the previous conversion's files (if any)
    const prevInputFile = currentInputFileRef.current || INPUT_FILE;
    const prevOutputFile = currentOutputFileRef.current || OUTPUT_FILE;
    
    addLog?.('info', 'Cleanup', `Pre-cleanup: checking for leftover files (${prevInputFile}, ${prevOutputFile})`);
    try {
      await ffmpeg.deleteFile(prevInputFile);
      addLog?.('info', 'Cleanup', `Leftover input file removed: ${prevInputFile}`);
    } catch {
      // File might not exist
    }
    try {
      await ffmpeg.deleteFile(prevOutputFile);
      addLog?.('info', 'Cleanup', `Leftover output file removed: ${prevOutputFile}`);
    } catch {
      // File might not exist
    }
  }, [addLog]);

  const loadFFmpeg = useCallback(async (): Promise<boolean> => {
    if (ffmpegRef.current) {
      addLog?.('info', 'Load', 'FFmpeg zaten yüklü');
      return true;
    }
    
    if (isLoading) {
      addLog?.('info', 'Load', 'FFmpeg zaten yükleniyor...');
      while (isLoading) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return ffmpegRef.current !== null;
    }

    setIsLoading(true);
    setError(null);
    updateProgress(0, 'loading', false);
    updateDebugInfo?.({ ffmpegLoadStatus: 'loading' });

    // Generate unique load ID for race condition prevention
    const loadId = ++currentLoadIdRef.current;
    
    // Check SharedArrayBuffer support for multi-threading
    const sabSupport = checkSharedArrayBufferSupport();
    
    // Get CPU core count
    const cpuCores = getCPUCores();
    
    // Determine thread count based on MT support and CPU cores
    const threadConfig = determineThreadCount(sabSupport.available, cpuCores);
    
    updateDebugInfo?.({ 
      sharedArrayBufferAvailable: sabSupport.available,
      crossOriginIsolated: sabSupport.crossOriginIsolated,
      cpuCores: cpuCores,
    });
    
    addLog?.('info', 'Load', logEngine(`CPU Cores: ${cpuCores}`));
    addLog?.('info', 'Load', logEngine(`crossOriginIsolated=${sabSupport.crossOriginIsolated}`));
    addLog?.('info', 'Load', logEngine(`SharedArrayBuffer=${sabSupport.available ? 'true' : 'false'}`));
    addLog?.('info', 'Load', logEngine(`Thread selection: ${threadConfig.reason}`));

    // Try multi-thread first ONLY if fully supported
    let loadSuccess = false;
    let fallbackReason: 
      | 'mt_cdn_failed'
      | 'mt_local_failed'
      | 'mt_init_timeout'
      | 'mt_init_failed'
      | 'sab_unavailable'
      | 'cross_origin_isolated_false'
      | 'unknown' 
      | null = null;
    let fallbackErrorMessage: string | null = null;
    
    if (sabSupport.crossOriginIsolated && sabSupport.available) {
      addLog?.('info', 'Load', logEngine(`Multi-thread eligible=true`));
      
      // Initialize debug tracking
      let mtLoadResult: MTLoadResult = { success: false };
      
      // Try CDN first
      addLog?.('info', 'Load', '[MT] CDN denemesi basliyor...');
      let cdnCoreURL: string | null = null;
      let cdnWasmURL: string | null = null;
      let cdnWorkerURL: string | null = null;
      let assetLoadTimes: { core?: number; wasm?: number; worker?: number } = {};
      
      try {
        const ffmpegMT = new FFmpeg();
        
        const loadLogHandler = ({ message }: { message: string }) => {
          console.log('[FFmpeg MT]', message);
        };
        ffmpegMT.on('log', loadLogHandler);
        
        // Load assets with detailed timing using fetch
        const coreStart = performance.now();
        try {
          const coreResponse = await fetch(`${CORE_MT_CDN}/ffmpeg-core.js`);
          if (!coreResponse.ok) throw new Error(`HTTP ${coreResponse.status}`);
          const coreData = await coreResponse.blob();
          cdnCoreURL = URL.createObjectURL(coreData);
          assetLoadTimes.core = Math.round(performance.now() - coreStart);
          addLog?.('info', 'Load', `[MT] core.js hazir: ${assetLoadTimes.core}ms`);
        } catch (coreErr) {
          const msg = coreErr instanceof Error ? coreErr.message : String(coreErr);
          addLog?.('error', 'Load', `[MT] core.js hatasi: ${msg}`);
          throw new Error(`MT_ASSET_LOAD_FAILED:core.js:${msg}`);
        }
        
        const wasmStart = performance.now();
        try {
          const wasmResponse = await fetch(`${CORE_MT_CDN}/ffmpeg-core.wasm`);
          if (!wasmResponse.ok) throw new Error(`HTTP ${wasmResponse.status}`);
          const wasmData = await wasmResponse.blob();
          cdnWasmURL = URL.createObjectURL(wasmData);
          assetLoadTimes.wasm = Math.round(performance.now() - wasmStart);
          addLog?.('info', 'Load', `[MT] core.wasm hazir: ${assetLoadTimes.wasm}ms`);
        } catch (wasmErr) {
          const msg = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
          addLog?.('error', 'Load', `[MT] core.wasm hatasi: ${msg}`);
          // Clean up core URL
          if (cdnCoreURL) URL.revokeObjectURL(cdnCoreURL);
          throw new Error(`MT_ASSET_LOAD_FAILED:core.wasm:${msg}`);
        }
        
        const workerStart = performance.now();
        try {
          const workerResponse = await fetch(`${CORE_MT_CDN}/ffmpeg-core.worker.js`);
          if (!workerResponse.ok) throw new Error(`HTTP ${workerResponse.status}`);
          const workerData = await workerResponse.blob();
          cdnWorkerURL = URL.createObjectURL(workerData);
          assetLoadTimes.worker = Math.round(performance.now() - workerStart);
          addLog?.('info', 'Load', `[MT] core.worker.js hazir: ${assetLoadTimes.worker}ms`);
        } catch (workerErr) {
          const msg = workerErr instanceof Error ? workerErr.message : String(workerErr);
          addLog?.('error', 'Load', `[MT] core.worker.js hatasi: ${msg}`);
          // Clean up URLs
          if (cdnCoreURL) URL.revokeObjectURL(cdnCoreURL);
          if (cdnWasmURL) URL.revokeObjectURL(cdnWasmURL);
          throw new Error(`MT_ASSET_LOAD_FAILED:core.worker.js:${msg}`);
        }
        
        mtLoadResult = {
          success: true,
          cdnAttempted: true,
          cdnSuccess: true,
          assetLoadTimes,
        };
        addLog?.('info', 'Load', `[MT] CDN assets tamamlandi (${assetLoadTimes.core! + assetLoadTimes.wasm! + assetLoadTimes.worker!}ms)`);
        
        // Now load FFmpeg with the blob URLs - apply timeout only to initialization
        addLog?.('info', 'Load', '[MT] FFmpeg baslatiliyor...');
        
        const loadPromise = ffmpegMT.load({
          coreURL: cdnCoreURL!,
          wasmURL: cdnWasmURL!,
          workerURL: cdnWorkerURL!,
        });
        
        const timeoutPromise = createTimeoutPromise(20000, 'MT_INIT_TIMEOUT');
        
        // Race between FFmpeg init and timeout
        await Promise.race([loadPromise, timeoutPromise]);
        
        // Check if this load is still valid
        if (loadId !== currentLoadIdRef.current) {
          addLog?.('info', 'Load', logEngine(`Stale load #${loadId}, ignoring`));
          ffmpegMT.terminate();
          // Clean up blob URLs
          if (cdnCoreURL) URL.revokeObjectURL(cdnCoreURL);
          if (cdnWasmURL) URL.revokeObjectURL(cdnWasmURL);
          if (cdnWorkerURL) URL.revokeObjectURL(cdnWorkerURL);
          throw new Error('STALE_LOAD');
        }
        
        // Success!
        ffmpegRef.current = ffmpegMT;
        logHandlerRef.current = loadLogHandler;
        engineTypeRef.current = threadConfig.engineType;
        threadCountRef.current = threadConfig.threads;
        
        updateDebugInfo?.({ 
          coreJsLoadStatus: 'loaded', 
          wasmLoadStatus: 'loaded',
          ffmpegLoadStatus: 'loaded',
          engineType: threadConfig.engineType,
          loadingMethod: threadConfig.engineType === 'multi-thread' ? 'Multi-Thread' : 'Single-Thread',
          threadCount: threadConfig.threads,
          fallbackReason: null,
          mtCdnAttempt: 'success',
          mtLocalAttempt: null,
          mtAssetLoadTimes: assetLoadTimes,
        });
        
        addLog?.('info', 'Load', logEngine(`MT CDN yükleme basarili`));
        addLog?.('info', 'Load', logEngine(`Actual engine: ${threadConfig.engineType}`));
        addLog?.('info', 'Load', logEngine(`Thread count: ${threadConfig.threads}`));
        addLog?.('success', 'Load', `${threadConfig.engineType === 'multi-thread' ? 'Multi-Thread' : 'Single-Thread'} FFmpeg yüklendi (${threadConfig.threads} threads)`);
        loadSuccess = true;
        
      } catch (mtErr) {
        const mtErrorMessage = mtErr instanceof Error ? mtErr.message : String(mtErr);
        
        // Clean up blob URLs if they exist
        if (cdnCoreURL) URL.revokeObjectURL(cdnCoreURL);
        if (cdnWasmURL) URL.revokeObjectURL(cdnWasmURL);
        if (cdnWorkerURL) URL.revokeObjectURL(cdnWorkerURL);
        
        if (mtErrorMessage === 'STALE_LOAD') {
          return ffmpegRef.current !== null;
        }
        
        // Determine fallback reason
        if (mtErrorMessage.includes('MT_INIT_TIMEOUT')) {
          fallbackReason = 'mt_init_timeout';
          fallbackErrorMessage = mtErrorMessage;
          addLog?.('warning', 'Load', logEngine(`MT initialization timeout (20sn)`));
        } else if (mtErrorMessage.includes('MT_ASSET_LOAD_FAILED')) {
          fallbackReason = 'mt_cdn_failed';
          fallbackErrorMessage = mtErrorMessage;
          addLog?.('warning', 'Load', logEngine(`MT CDN asset hatasi: ${mtErrorMessage}`));
        } else {
          fallbackReason = 'mt_init_failed';
          fallbackErrorMessage = mtErrorMessage;
          addLog?.('warning', 'Load', logEngine(`MT initialization hatasi: ${mtErrorMessage}`));
        }
        
        // Try local fallback
        addLog?.('info', 'Load', '[MT] Local fallback deneniyor...');
        
        let localCoreURL: string | null = null;
        let localWasmURL: string | null = null;
        let localWorkerURL: string | null = null;
        
        try {
          const ffmpegMTLocal = new FFmpeg();
          const loadLogHandler = ({ message }: { message: string }) => {
            console.log('[FFmpeg MT Local]', message);
          };
          ffmpegMTLocal.on('log', loadLogHandler);
          
          // Load from local paths
          localCoreURL = `${CORE_MT_LOCAL}/ffmpeg-core.js`;
          localWasmURL = `${CORE_MT_LOCAL}/ffmpeg-core.wasm`;
          localWorkerURL = `${CORE_MT_LOCAL}/ffmpeg-core.worker.js`;
          
          addLog?.('info', 'Load', `[MT] Local paths: ${localCoreURL}`);
          
          const loadPromise = ffmpegMTLocal.load({
            coreURL: localCoreURL,
            wasmURL: localWasmURL,
            workerURL: localWorkerURL,
          });
          
          const timeoutPromise = createTimeoutPromise(20000, 'MT_LOCAL_INIT_TIMEOUT');
          
          await Promise.race([loadPromise, timeoutPromise]);
          
          if (loadId !== currentLoadIdRef.current) {
            ffmpegMTLocal.terminate();
            throw new Error('STALE_LOAD');
          }
          
          // Local success!
          ffmpegRef.current = ffmpegMTLocal;
          logHandlerRef.current = loadLogHandler;
          engineTypeRef.current = threadConfig.engineType;
          threadCountRef.current = threadConfig.threads;
          
          updateDebugInfo?.({ 
            coreJsLoadStatus: 'loaded', 
            wasmLoadStatus: 'loaded',
            ffmpegLoadStatus: 'loaded',
            engineType: threadConfig.engineType,
            loadingMethod: threadConfig.engineType === 'multi-thread' ? 'Multi-Thread' : 'Single-Thread',
            threadCount: threadConfig.threads,
            fallbackReason: null,
            mtCdnAttempt: 'failed',
            mtLocalAttempt: 'success',
            mtCdnError: fallbackErrorMessage,
          });
          
          addLog?.('info', 'Load', logEngine(`MT Local yükleme basarili`));
          addLog?.('info', 'Load', logEngine(`Actual engine: ${threadConfig.engineType}`));
          addLog?.('info', 'Load', logEngine(`Thread count: ${threadConfig.threads}`));
          addLog?.('success', 'Load', `${threadConfig.engineType === 'multi-thread' ? 'Multi-Thread' : 'Single-Thread'} FFmpeg (local) yüklendi (${threadConfig.threads} threads)`);
          loadSuccess = true;
          
        } catch (localErr) {
          const localErrorMessage = localErr instanceof Error ? localErr.message : String(localErr);
          
          if (localErrorMessage !== 'STALE_LOAD') {
            fallbackReason = 'mt_local_failed';
            fallbackErrorMessage = localErrorMessage;
            addLog?.('warning', 'Load', logEngine(`MT Local hatasi: ${localErrorMessage}`));
            
            updateDebugInfo?.({ 
              mtCdnAttempt: 'failed',
              mtLocalAttempt: 'failed',
              mtCdnError: mtErrorMessage,
              mtLocalError: localErrorMessage,
            });
          }
        }
      }
    } else {
      // Skip MT entirely - not supported
      if (!sabSupport.crossOriginIsolated) {
        fallbackReason = 'cross_origin_isolated_false';
        addLog?.('info', 'Load', logEngine(`Multi-thread eligible=false (crossOriginIsolated=false)`));
      } else if (!sabSupport.available) {
        fallbackReason = 'sab_unavailable';
        addLog?.('info', 'Load', logEngine(`Multi-thread eligible=false (SharedArrayBuffer unavailable)`));
      }
    }
    
    // Fallback to single-thread
    if (!loadSuccess) {
      addLog?.('info', 'Load', logEngine(`Fallback reason: ${fallbackReason || 'unknown'}`));
      addLog?.('info', 'Load', 'Single-Thread FFmpeg deneniyor...');
      
      // Increment load ID to invalidate any pending loads
      currentLoadIdRef.current++;
      
      updateDebugInfo?.({ 
        ffmpegLoadStatus: 'loading',
        engineType: threadConfig.engineType,
        loadingMethod: threadConfig.engineType === 'multi-thread' ? 'Multi-Thread' : 'Single-Thread',
        threadCount: threadConfig.threads,
        fallbackReason,
        fallbackErrorMessage,
      });
      
      let ffmpegST: FFmpeg | null = null;
      let loadLogHandler: ((data: { message: string }) => void) | null = null;
      const stLoadId = currentLoadIdRef.current;
      
      try {
        ffmpegST = new FFmpeg();
        
        loadLogHandler = ({ message }: { message: string }) => {
          console.log('[FFmpeg ST]', message);
        };
        ffmpegST.on('log', loadLogHandler);
        
        // Try local ST first
        addLog?.('info', 'Load', '[ST] Local denemesi...');
        
        try {
          const loadPromise = ffmpegST.load({
            coreURL: `${CORE_ST_LOCAL}/ffmpeg-core.js`,
            wasmURL: `${CORE_ST_LOCAL}/ffmpeg-core.wasm`,
          });
          
          const timeoutPromise = createTimeoutPromise(15000, 'ST_LOCAL_TIMEOUT');
          
          await Promise.race([loadPromise, timeoutPromise]);
          
          if (stLoadId !== currentLoadIdRef.current) {
            ffmpegST?.terminate();
            throw new Error('STALE_LOAD');
          }
          
          addLog?.('info', 'Load', '[ST] Local yükleme basarili');
          
        } catch {
          addLog?.('info', 'Load', '[ST] CDN denemesi...');
          
          // Fallback to CDN
          const loadPromise = ffmpegST!.load({
            coreURL: `${CORE_ST_CDN}/ffmpeg-core.js`,
            wasmURL: `${CORE_ST_CDN}/ffmpeg-core.wasm`,
          });
          
          const timeoutPromise = createTimeoutPromise(60000, 'ST_CDN_TIMEOUT');
          
          await Promise.race([loadPromise, timeoutPromise]);
          
          if (stLoadId !== currentLoadIdRef.current) {
            ffmpegST?.terminate();
            throw new Error('STALE_LOAD');
          }
          
          addLog?.('info', 'Load', '[ST] CDN yükleme basarili');
        }
        
        // Check if this load is still valid
        if (stLoadId !== currentLoadIdRef.current) {
          addLog?.('info', 'Load', logEngine(`Stale load #${stLoadId}, ignoring`));
          ffmpegST?.terminate();
          throw new Error('STALE_LOAD');
        }
        
        ffmpegRef.current = ffmpegST;
        logHandlerRef.current = loadLogHandler;
        engineTypeRef.current = threadConfig.engineType;
        threadCountRef.current = threadConfig.threads;
        
        updateDebugInfo?.({ 
          coreJsLoadStatus: 'loaded', 
          wasmLoadStatus: 'loaded',
          ffmpegLoadStatus: 'loaded',
          engineType: threadConfig.engineType,
          loadingMethod: threadConfig.engineType === 'multi-thread' ? 'Multi-Thread' : 'Single-Thread',
          threadCount: threadConfig.threads,
        });
        
        addLog?.('info', 'Load', logEngine(`Actual engine: ${threadConfig.engineType}`));
        addLog?.('info', 'Load', logEngine(`Thread count: ${threadConfig.threads}`));
        addLog?.('success', 'Load', `${threadConfig.engineType === 'multi-thread' ? 'Multi-Thread' : 'Single-Thread'} FFmpeg yüklendi (${threadConfig.threads} threads)`);
        loadSuccess = true;
        
      } catch (stErr) {
        const stErrorMessage = stErr instanceof Error ? stErr.message : String(stErr);
        
        if (stErrorMessage === 'STALE_LOAD') {
          setIsLoading(false);
          return ffmpegRef.current !== null;
        }
        
        addLog?.('error', 'Load', logEngine(`ST load failed: ${stErrorMessage}`));
        
        updateDebugInfo?.({ 
          ffmpegLoadStatus: 'error',
          errorCode: 'FFMPEG_LOAD_ERROR',
          errorMessage: stErrorMessage,
          loadingMethod: 'None',
        });
        
        let errorMessage = 'Dönüştürücü yüklenemedi.';
        let errorCode = 'FFMPEG_LOAD_ERROR';
        
        if (stErrorMessage.includes('fetch') || stErrorMessage.includes('network') || stErrorMessage.includes('Failed to') || stErrorMessage.includes('404')) {
          errorMessage = 'FFmpeg dosyaları yüklenemedi. Lütfen internet bağlantınızı kontrol edin.';
          errorCode = 'FFMPEG_FETCH_ERROR';
        } else if (stErrorMessage.includes('WASM') || stErrorMessage.includes('wasm')) {
          errorMessage = 'WebAssembly yüklenemedi. Lütfen sayfayı yenileyin.';
          errorCode = 'WASM_LOAD_ERROR';
        }
        
        const errorObj: ConversionError = {
          code: errorCode,
          message: errorMessage,
          technical: `ffmpeg.load() başarısız\n${stErrorMessage}`,
        };
        setError(errorObj);
        updateProgress(0, 'error', false);
        setIsLoading(false);
        return false;
      }
    }

    setIsLoaded(true);
    updateProgress(0, 'idle', false);
    addLog?.('success', 'Load', logEngine(`FFmpeg ready (${engineTypeRef.current === 'multi-thread' ? 'Multi-Thread' : 'Single-Thread'}, ${threadCountRef.current} threads)`));
    return true;
  }, [isLoading, updateProgress, addLog, updateDebugInfo, normalizeError]);

  // Calculate maxrate based on source resolution and quality preset
  const getMaxRateForResolution = (width: number | null, presetMaxRate: number): number => {
    if (!width) return presetMaxRate; // Default to preset maxrate
    if (width <= 480) return 400; // 480p or smaller - cap at 400k
    if (width <= 720) return presetMaxRate; // 720p - use preset
    return presetMaxRate; // 1080p+ - will be scaled to 720p, use preset
  };

  // Get scale filter for resolution
  const getScaleFilter = (sourceWidth: number | null): string | null => {
    if (!sourceWidth) return null;
    if (sourceWidth <= 720) return null; // No scaling needed
    return 'scale=720:-2'; // Scale to 720px width, maintain aspect ratio
  };

  // Build FFmpeg arguments
  const buildFFmpegArgs = (
    crf: number,
    maxRate: number,
    useFallback: boolean, 
    sourceWidth: number | null,
    sourceHeight: number | null,
    inputFile: string,
    outputFile: string
  ): string[] => {
    const mobile = isMobileDevice();
    const effectiveMaxRate = getMaxRateForResolution(sourceWidth, maxRate);
    const bufSize = Math.ceil(effectiveMaxRate * 2); // bufsize = 2x maxrate
    const scaleFilter = getScaleFilter(sourceWidth);

    // Use engine-specific thread count from threadCountRef
    const actualEngine = engineTypeRef.current;
    const threads = threadCountRef.current;
    
    addLog?.('info', 'Convert', logEngine(`Using engine: ${actualEngine}`));
    addLog?.('info', 'Convert', logEngine(`Thread count: ${threads}`));

    const args: string[] = [
      '-fflags', '+genpts',
      '-i', inputFile,
      '-map', '0:v:0',
      '-map', '0:a?',
    ];

    // Build video filter
    const videoFilters: string[] = [];
    if (scaleFilter) {
      videoFilters.push(scaleFilter);
    }
    if (useFallback) {
      videoFilters.push('setpts=N/(30*TB)');
    }
    videoFilters.push('fps=30');

    if (videoFilters.length > 0) {
      args.push('-vf', videoFilters.join(','), '-fps_mode', 'cfr');
      if (useFallback) {
        addLog?.('info', 'Convert', `Fallback komut (setpts filtresi)`);
      }
    }

    // Video encoding with constrained bitrate
    args.push(
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-level:v', '3.1',
      '-preset', mobile ? 'ultrafast' : 'veryfast',
      '-crf', crf.toString(),
      '-maxrate', `${effectiveMaxRate}k`,
      '-bufsize', `${bufSize}k`,
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-threads', threads.toString(),
    );

    // Audio encoding - only if source has audio (using -map 0:a?)
    args.push(
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '48000',
      '-ac', '1', // Mono
      '-movflags', '+faststart',
      outputFile,
    );

    addLog?.('info', 'Convert', `FFmpeg: CRF=${crf}, maxrate=${effectiveMaxRate}k, bufsize=${bufSize}k, scale=${scaleFilter || 'none'}`);

    return args;
  };

  const convert = useCallback(async (
    file: File,
    quality: QualityPreset,
    onStageChange?: (stage: ConversionStage) => void,
    videoDuration?: number | null,
    sourceWidth?: number | null,
    sourceHeight?: number | null
  ): Promise<ConversionResult> => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      const err = new Error('FFmpeg henüz yüklenmedi');
      addLog?.('error', 'Convert', `HATA: FFmpeg mevcut değil`);
      const errorObj: ConversionError = {
        code: 'FFMPEG_NOT_LOADED',
        message: 'FFmpeg henüz yüklenmedi.',
        technical: `ffmpegRef.current is null`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    // Generate unique job ID and file names for this conversion
    const jobId = generateJobId();
    const inputFile = generateInputFileName(jobId);
    const outputFile = generateOutputFileName(jobId);
    jobIdRef.current = jobId;
    currentInputFileRef.current = inputFile;
    currentOutputFileRef.current = outputFile;
    addLog?.('info', 'Convert', `Job ID: ${jobId}, Input: ${inputFile}, Output: ${outputFile}`);

    // Pre-cleanup: Remove any leftover files from previous conversion
    addLog?.('info', 'Cleanup', 'Temizlik: önceki dosyalar kontrol ediliyor...');
    await preCleanup();

    // Reset refs for new conversion
    maxEncodedTimeRef.current = 0;
    
    // Store video duration for progress calculation
    // If we have HTML5 metadata, use it; otherwise, we'll use FFmpeg fallback
    const validVideoDuration = videoDuration ?? null;
    hasHtml5MetadataRef.current = validVideoDuration !== null && validVideoDuration > 0;
    videoDurationRef.current = validVideoDuration;
    
    if (validVideoDuration !== null && validVideoDuration > 0) {
      addLog?.('info', 'Convert', `Video süresi (HTML5): ${validVideoDuration.toFixed(2)} sn`);
    } else {
      addLog?.('info', 'Convert', 'Video süresi: FFmpeg fallback kullanılacak');
    }
    if (sourceWidth && sourceHeight) {
      addLog?.('info', 'Convert', `Çözünürlük: ${sourceWidth}x${sourceHeight}`);
    }

    // Initialize
    startTimeRef.current = Date.now();
    clearAllTimeouts();
    setError(null);
    updateDebugInfo?.({ 
      fileWriteStatus: 'idle', 
      ffmpegExecStatus: 'idle',
      ffmpegExecStartTime: null, 
      lastProgressValue: null,
      errorCode: null,
      errorMessage: null,
      cleanupStatus: 'idle',
      totalDuration: validVideoDuration,
      metadataSource: hasHtml5MetadataRef.current ? 'html5' : null,
    });

    // Get quality preset settings (matching WebCodecs qualityConfig values)
    // CRF values: lower = better quality, higher = worse quality
    // maxrate values are in kbps to match FFmpeg's expected format
    // These values are optimized for map/text readability
    const qualitySettingsMap: Record<QualityPreset, { crf: number; maxrate: number }> = {
      // Consistent with qualityConfig.ts for 720p vertical video
      small: { crf: 30, maxrate: 600 },    // ~600 kbps target - minimum for map text
      standard: { crf: 26, maxrate: 1000 }, // ~1 Mbps target
      high: { crf: 20, maxrate: 1800 },    // ~1.8 Mbps target
    };
    const { crf, maxrate } = qualitySettingsMap[quality];

    const deviceMemory = getDeviceMemory();
    const cpuCores = getCPUCores();
    const mobile = isMobileDevice();
    addLog?.('info', 'Convert', `Cihaz: Hafıza=${deviceMemory || 'bilinmiyor'}GB, Çekirdek=${cpuCores}, Mobil=${mobile}`);
    addLog?.('info', 'Convert', `Dosya boyutu: ${(file.size / (1024 * 1024)).toFixed(2)}MB, CRF=${crf}, maxrate=${maxrate}k`);

    // Step 1: Read file
    onStageChange?.('reading');
    updateProgress(0, 'reading', false);
    addLog?.('info', 'Convert', 'Dosya okunuyor...');
    
    let fileData: Uint8Array;
    try {
      fileData = new Uint8Array(await file.arrayBuffer());
      addLog?.('info', 'Convert', `Dosya belleğe yüklendi: ${fileData.byteLength} bytes`);
      updateDebugInfo?.({ fileSize: fileData.byteLength });
    } catch (err) {
      const { message, stack } = normalizeError(err);
      addLog?.('error', 'Convert', `FILE_READ_FAILED: ${message}`);
      const errorObj: ConversionError = {
        code: 'FILE_READ_ERROR',
        message: 'Video dosyası okunamadı.',
        technical: `file.arrayBuffer() başarısız\n${message}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    // Step 2: Write file to FFmpeg VFS
    addLog?.('info', 'Convert', `WRITE_FILE_STARTED`);
    updateDebugInfo?.({ fileWriteStatus: 'writing' });
    
    try {
      fileDataRef.current = fileData;
      await ffmpeg.writeFile(inputFile, fileData);
      updateDebugInfo?.({ fileWriteStatus: 'written' });
      addLog?.('success', 'Convert', `WRITE_FILE_SUCCESS`);
    } catch (err) {
      const { message, stack } = normalizeError(err);
      updateDebugInfo?.({ fileWriteStatus: 'error' });
      addLog?.('error', 'Convert', `WRITE_FILE_FAILED: ${message}`);
      const errorObj: ConversionError = {
        code: 'WRITE_FILE_ERROR',
        message: 'Dosya FFmpeg VFS\'ye yazılamadı.',
        technical: `ffmpeg.writeFile() başarısız\n${message}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }
  
    // Step 3: Execute FFmpeg
    onStageChange?.('converting');
    updateProgress(8, 'converting', false, null, null, videoDurationRef.current);
    const execStartTime = Date.now();
    addLog?.('info', 'Convert', 'EXEC_STARTED');
    updateDebugInfo?.({ ffmpegExecStatus: 'running', ffmpegExecStartTime: execStartTime });

    const ffmpegArgs = buildFFmpegArgs(
      crf,
      maxrate,
      false, 
      sourceWidth ?? null, 
      sourceHeight ?? null,
      inputFile,
      outputFile
    );
    // Store the command for debug panel
    ffmpegCommandRef.current = ffmpegArgs;
    addLog?.('info', 'FFmpeg', `Komut: ${ffmpegArgs.join(' ')}`);
    updateDebugInfo?.({ ffmpegCommand: ffmpegArgs.join(' ') });

    let maxDuplicatedFrames = 0;
    let hasWarnedAboutDuplicates = false;
    let hasRetriedWithFallback = false;
    let lastProgressPercent = 8;

    // Progress handler
    // FFmpeg progress.time is in microseconds, convert to seconds: time / 1_000_000
    // IMPORTANT: Only use time for progress calculation, NOT data.progress
    progressHandlerRef.current = (data: { progress: number; time?: number }) => {
      lastActivityRef.current = Date.now();
      
      // Only use progress.time (microseconds -> seconds), never data.progress
      if (data.time !== undefined && data.time > 0) {
        const encodedSeconds = data.time / 1_000_000;
        const realDuration = videoDurationRef.current;
        
        // Calculate percentage based on encodedSeconds / realDurationSeconds
        // Progress range: 8-98%, never goes backwards
        let newPercent = 8;
        if (realDuration !== null && realDuration > 0.1) {
          const ratio = Math.min(1, encodedSeconds / realDuration);
          newPercent = Math.floor(8 + ratio * 90); // 8% to 98%
          newPercent = Math.min(98, Math.max(8, newPercent));
        }
        lastProgressPercent = Math.max(lastProgressPercent, newPercent);
        
        // Calculate average encoding speed
        const elapsedEncodeSeconds = (Date.now() - execStartTime) / 1000;
        const avgSpeed = elapsedEncodeSeconds > 0 
          ? encodedSeconds / elapsedEncodeSeconds 
          : null;
        
        updateProgress(lastProgressPercent, 'converting', true, encodedSeconds, avgSpeed, realDuration);
        updateDebugInfo?.({ 
          lastProgressValue: lastProgressPercent, 
          encodedTime: encodedSeconds,
          averageSpeed: avgSpeed,
        });
      }
    };
    ffmpeg.on('progress', progressHandlerRef.current);

    // Audio detection flag
    let hasAudioDetected = false;
    let conversionSucceeded = false;
    let ffmpegFallbackLogged = false;

    // FFmpeg log handler
    const ffmpegLogHandler = ({ message }: { message: string }) => {
      lastActivityRef.current = Date.now();
      
      // Detect audio stream in FFmpeg output
      // Only count as audio if it's NOT "audio:0kB" which means no audio
      if (!hasAudioDetected && /Audio:/i.test(message) && !/audio:0kB/i.test(message)) {
        hasAudioDetected = true;
        addLog?.('info', 'Convert', 'Audio stream detected - AAC encoding enabled');
      }
      
      // Detect when there's NO audio (audio:0kB)
      if (/audio:0kB/i.test(message)) {
        hasAudioDetected = false;
        addLog?.('info', 'Convert', 'Çıktıda ses bulunamadı (audio:0kB)');
      }
      
      // Ignore "Aborted()" messages that occur after successful completion
      // These are normal - they happen when worker is terminated after cleanup
      if (conversionSucceeded && /Aborted\(\)/i.test(message)) {
        return; // Skip logging aborted errors after success
      }
      
      // Also filter out "Aborted()" during cleanup - log at debug level
      if (/Aborted\(\)/i.test(message)) {
        // Don't log this as an error - it's expected during cleanup
        return;
      }
      
      if (message === lastFFmpegMessageRef.current) return;
      lastFFmpegMessageRef.current = message;
      
      const stats = parseFFmpegProgress(message);
      if (stats) {
        // Update last encoded time reference
        if (stats.encodedTime !== null) {
          lastEncodedTimeRef.current = stats.encodedTime;
          
          // Track max encoded time for FFmpeg fallback
          if (stats.encodedTime > maxEncodedTimeRef.current) {
            maxEncodedTimeRef.current = stats.encodedTime;
          }
          
          // If HTML5 metadata failed, use FFmpeg fallback for total duration
          if (!hasHtml5MetadataRef.current && videoDurationRef.current === null && maxEncodedTimeRef.current > 0) {
            // Use the max encoded time as the total duration
            videoDurationRef.current = maxEncodedTimeRef.current;
            updateDebugInfo?.({ 
              totalDuration: maxEncodedTimeRef.current,
              metadataSource: 'ffmpeg_fallback',
            });
            if (!ffmpegFallbackLogged) {
              ffmpegFallbackLogged = true;
              addLog?.('info', 'Convert', `Video süresi (FFmpeg fallback): ${maxEncodedTimeRef.current.toFixed(2)} sn`);
            }
          }
        }

        updateDebugInfo?.({
          encodedFrame: stats.encodedFrame,
          encodedTime: stats.encodedTime,
          encodingFps: stats.encodingFps,
          duplicatedFrames: stats.duplicatedFrames,
          encodingSpeed: stats.encodingSpeed,
        });

        if (stats.duplicatedFrames !== null) {
          if (stats.duplicatedFrames > maxDuplicatedFrames) {
            maxDuplicatedFrames = stats.duplicatedFrames;
          }
          if (stats.duplicatedFrames > DUPLICATE_FRAME_WARNING_THRESHOLD && !hasWarnedAboutDuplicates) {
            hasWarnedAboutDuplicates = true;
            addLog?.('warning', 'Convert', `Timestamp problemi: ${stats.duplicatedFrames} duplicate frame`);
          }
        }

        // Update progress based on encoded time from log stats
        // Use same calculation logic as progress handler
        if (stats.encodedTime !== null) {
          const encodedSeconds = stats.encodedTime;
          const realDuration = videoDurationRef.current;
          
          let newPercent = lastProgressPercent;
          if (realDuration !== null && realDuration > 0.1) {
            const ratio = Math.min(1, encodedSeconds / realDuration);
            newPercent = Math.floor(8 + ratio * 90);
            newPercent = Math.min(98, Math.max(8, newPercent));
          }
          lastProgressPercent = Math.max(lastProgressPercent, newPercent);
          
          // Calculate average encoding speed
          const elapsedEncodeSeconds = (Date.now() - execStartTime) / 1000;
          const avgSpeed = elapsedEncodeSeconds > 0 
            ? encodedSeconds / elapsedEncodeSeconds 
            : stats.encodingSpeed;
          
          updateProgress(lastProgressPercent, 'converting', true, encodedSeconds, avgSpeed, realDuration);
          updateDebugInfo?.({ 
            lastProgressValue: lastProgressPercent, 
            encodedTime: encodedSeconds,
            averageSpeed: avgSpeed,
          });
        } else if (stats.encodedFrame !== null && stats.encodedFrame > 0) {
          // Fallback: animate progress for unknown duration
          updateProgress(lastProgressPercent, 'converting', true, null, stats.encodingSpeed, videoDurationRef.current);
        }
      }

      addLog?.('info', 'FFmpeg', message);
    };
    ffmpeg.on('log', ffmpegLogHandler);

    // Reset activity timer for execution
    lastActivityRef.current = Date.now();
    lastEncodedTimeRef.current = null;
    
    // Log audio detection status
    if (hasAudioDetected) {
      addLog?.('info', 'Convert', 'Audio stream detected - AAC encoding enabled');
    } else {
      addLog?.('info', 'Convert', 'No audio stream detected');
    }

    // Stall timeout - check every 10 seconds
    let stallCheckInterval: ReturnType<typeof setInterval> | null = null;
    stallCheckInterval = setInterval(async () => {
      const timeSinceLastActivity = Date.now() - lastActivityRef.current;
      if (timeSinceLastActivity >= STALL_TIMEOUT_MS) {
        if (stallCheckInterval) {
          clearInterval(stallCheckInterval);
          stallCheckInterval = null;
        }
        addLog?.('error', 'Convert', `STALL_DETECTED: 90 saniye aktivite yok`);
        
        // Terminate and cleanup - this will handle the error state
        await cleanupResources({ terminateWorker: true, reason: 'Stall timeout' });
        
        const errorObj: ConversionError = {
          code: 'EXEC_STALLED',
          message: 'Video dönüştürme işlemi yavaşladı veya durdu.',
          technical: `90 saniye boyunca FFmpeg aktivitesi yok (frame=${lastEncodedTimeRef.current !== null ? 'encoded' : 'unknown'})`,
        };
        setError(errorObj);
        updateDebugInfo?.({ errorCode: 'EXEC_STALLED', errorMessage: errorObj.message });
        onStageChange?.('error');
        throw new Error('EXEC_STALLED');
      }
    }, 10000); // Check every 10 seconds

    // Safety timeout - 30 minutes absolute limit
    safetyTimeoutRef.current = setTimeout(async () => {
      if (stallCheckInterval) {
        clearInterval(stallCheckInterval);
        stallCheckInterval = null;
      }
      addLog?.('error', 'Convert', `SAFETY_TIMEOUT: 30 dakika aşıldı`);
      
      // Terminate and cleanup
      await cleanupResources({ terminateWorker: true, reason: 'Safety timeout (30 min)' });
      
      const errorObj: ConversionError = {
        code: 'EXEC_SAFETY_TIMEOUT',
        message: 'Video dönüştürme işlemi çok uzun sürdü.',
        technical: `30 dakika güvenlik limiti aşıldı`,
      };
      setError(errorObj);
      updateDebugInfo?.({ errorCode: 'EXEC_SAFETY_TIMEOUT', errorMessage: errorObj.message });
      onStageChange?.('error');
      throw new Error('EXEC_SAFETY_TIMEOUT');
    }, MAX_EXECUTION_TIME_MS);

    let execSuccess = false;
    let execError: Error | null = null;

    try {
      await ffmpeg.exec(ffmpegArgs);
      execSuccess = true;
      addLog?.('success', 'Convert', 'EXEC_SUCCESS');
      updateDebugInfo?.({ ffmpegExecStatus: 'completed' });
    } catch (err) {
      const { message } = normalizeError(err);
      execError = err instanceof Error ? err : new Error(message);
      
      // Check if it's a stall or safety timeout (already handled)
      if (message === 'EXEC_STALLED' || message === 'EXEC_SAFETY_TIMEOUT') {
        throw execError;
      }
      
      // Retry with fallback if duplicate frames are high
      if (!hasRetriedWithFallback && maxDuplicatedFrames > DUPLICATE_FRAME_ABORT_THRESHOLD) {
        hasRetriedWithFallback = true;
        addLog?.('warning', 'Convert', `Fallback: ${maxDuplicatedFrames} duplicate frame`);
        
        if (progressHandlerRef.current) {
          ffmpeg.off('progress', progressHandlerRef.current);
          progressHandlerRef.current = null;
        }
        ffmpeg.off('log', ffmpegLogHandler);
        
        // Reset activity timer
        lastActivityRef.current = Date.now();
        lastEncodedTimeRef.current = null;
        maxDuplicatedFrames = 0;
        hasWarnedAboutDuplicates = false;
        lastProgressPercent = 10;
        lastFFmpegMessageRef.current = '';
        
        const fallbackArgs = buildFFmpegArgs(
          crf,
          maxrate,
          true, 
          sourceWidth ?? null, 
          sourceHeight ?? null,
          inputFile,
          outputFile
        );
        addLog?.('info', 'FFmpeg', `Fallback Komut: ${fallbackArgs.join(' ')}`);
        
        // Update progress handler for fallback - same logic as main handler
        progressHandlerRef.current = (data: { progress: number; time?: number }) => {
          lastActivityRef.current = Date.now();
          // Only use progress.time (microseconds -> seconds), never data.progress
          if (data.time !== undefined && data.time > 0) {
            const encodedSeconds = data.time / 1_000_000;
            const realDuration = videoDurationRef.current;
            
            // Calculate percentage based on encodedSeconds / realDurationSeconds
            // Progress range: 8-98%, never goes backwards
            let newPercent = 10; // Start slightly higher for fallback
            if (realDuration !== null && realDuration > 0.1) {
              const ratio = Math.min(1, encodedSeconds / realDuration);
              newPercent = Math.floor(8 + ratio * 90); // 8% to 98%
              newPercent = Math.min(98, Math.max(10, newPercent));
            }
            lastProgressPercent = Math.max(lastProgressPercent, newPercent);
            
            // Calculate average encoding speed
            const elapsedEncodeSeconds = (Date.now() - execStartTime) / 1000;
            const avgSpeed = elapsedEncodeSeconds > 0 
              ? encodedSeconds / elapsedEncodeSeconds 
              : null;
            
            updateProgress(lastProgressPercent, 'converting', true, encodedSeconds, avgSpeed, realDuration);
            updateDebugInfo?.({ 
              lastProgressValue: lastProgressPercent, 
              encodedTime: encodedSeconds,
              averageSpeed: avgSpeed,
            });
          }
        };
        ffmpeg.on('progress', progressHandlerRef.current);
        
        const retryLogHandler = ({ message }: { message: string }) => {
          lastActivityRef.current = Date.now();
          if (message === lastFFmpegMessageRef.current) return;
          lastFFmpegMessageRef.current = message;
          
          const stats = parseFFmpegProgress(message);
          if (stats) {
            if (stats.encodedTime !== null) {
              lastEncodedTimeRef.current = stats.encodedTime;
              
              // Track max encoded time for FFmpeg fallback
              if (stats.encodedTime > maxEncodedTimeRef.current) {
                maxEncodedTimeRef.current = stats.encodedTime;
              }
              
              // If HTML5 metadata failed, use FFmpeg fallback for total duration
              if (!hasHtml5MetadataRef.current && videoDurationRef.current === null && maxEncodedTimeRef.current > 0) {
                videoDurationRef.current = maxEncodedTimeRef.current;
                updateDebugInfo?.({ 
                  totalDuration: maxEncodedTimeRef.current,
                  metadataSource: 'ffmpeg_fallback',
                });
                if (!ffmpegFallbackLogged) {
                  ffmpegFallbackLogged = true;
                  addLog?.('info', 'Convert', `Video süresi (FFmpeg fallback): ${maxEncodedTimeRef.current.toFixed(2)} sn`);
                }
              }
            }
            updateDebugInfo?.({
              encodedFrame: stats.encodedFrame,
              encodedTime: stats.encodedTime,
              encodingFps: stats.encodingFps,
              duplicatedFrames: stats.duplicatedFrames,
              encodingSpeed: stats.encodingSpeed,
            });
            if (stats.duplicatedFrames !== null && stats.duplicatedFrames > maxDuplicatedFrames) {
              maxDuplicatedFrames = stats.duplicatedFrames;
            }
            
            // Update progress using same logic as main handler
            if (stats.encodedTime !== null) {
              const encodedSeconds = stats.encodedTime;
              const realDuration = videoDurationRef.current;
              
              let newPercent = lastProgressPercent;
              if (realDuration !== null && realDuration > 0.1) {
                const ratio = Math.min(1, encodedSeconds / realDuration);
                newPercent = Math.floor(8 + ratio * 90);
                newPercent = Math.min(98, Math.max(10, newPercent));
              }
              lastProgressPercent = Math.max(lastProgressPercent, newPercent);
              
              // Calculate average encoding speed
              const elapsedEncodeSeconds = (Date.now() - execStartTime) / 1000;
              const avgSpeed = elapsedEncodeSeconds > 0 
                ? encodedSeconds / elapsedEncodeSeconds 
                : stats.encodingSpeed;
              
              updateProgress(lastProgressPercent, 'converting', true, encodedSeconds, avgSpeed, realDuration);
              updateDebugInfo?.({ 
                lastProgressValue: lastProgressPercent, 
                encodedTime: encodedSeconds,
                averageSpeed: avgSpeed,
              });
            }
          }
          addLog?.('info', 'FFmpeg', message);
        };
        ffmpeg.on('log', retryLogHandler);
        
        try {
          await ffmpeg.exec(fallbackArgs);
          execSuccess = true;
          addLog?.('success', 'Convert', 'EXEC_SUCCESS (Fallback)');
          updateDebugInfo?.({ ffmpegExecStatus: 'completed' });
        } catch (retryErr) {
          const { message: retryMsg } = normalizeError(retryErr);
          execError = retryErr instanceof Error ? retryErr : new Error(retryMsg);
          if (progressHandlerRef.current) {
            ffmpeg.off('progress', progressHandlerRef.current);
            progressHandlerRef.current = null;
          }
          ffmpeg.off('log', retryLogHandler);
        }
      }
    }
    
    // Clean up timeouts and handlers
    if (stallCheckInterval) {
      clearInterval(stallCheckInterval);
    }
    clearAllTimeouts();
    if (progressHandlerRef.current) {
      ffmpeg.off('progress', progressHandlerRef.current);
      progressHandlerRef.current = null;
    }
    ffmpeg.off('log', ffmpegLogHandler);
    // Note: retryLogHandler is already cleaned up in the catch block above if retry was attempted

    if (!execSuccess && execError) {
      // Only set ffmpegExecStatus to error, NOT ffmpegLoadStatus
      // FFmpeg may still be loaded even if execution fails
      updateDebugInfo?.({ ffmpegExecStatus: 'error' });
      
      const execErrorMessage = execError instanceof Error ? execError.message : String(execError);
      const errorObj: ConversionError = {
        code: 'CONVERSION_ERROR',
        message: 'Video dönüştürülürken bir hata oluştu.',
        technical: `ffmpeg.exec() başarısız\nHata: ${execErrorMessage}`,
      };
      setError(errorObj);
      updateDebugInfo?.({ errorCode: 'CONVERSION_ERROR', errorMessage: errorObj.message });
      onStageChange?.('error');
      throw execError;
    }

    // Step 4: Read output
    onStageChange?.('finalizing');
    updateProgress(99, 'finalizing', true, null, null, videoDurationRef.current);
    addLog?.('info', 'Convert', 'MP4 okunuyor...');
    
    let outputData: Uint8Array | string;
    try {
      const rawOutput = await ffmpeg.readFile(outputFile);
      if (rawOutput instanceof Uint8Array) {
        outputData = rawOutput;
      } else if (typeof rawOutput === 'string') {
        outputData = rawOutput;
      } else {
        outputData = new Uint8Array(rawOutput as ArrayBuffer);
      }
      addLog?.('success', 'Convert', `OUTPUT_READ_SUCCESS: ${outputData instanceof Uint8Array ? outputData.byteLength : 'bilinmiyor'} bytes`);
    } catch (err) {
      const { message, stack } = normalizeError(err);
      addLog?.('error', 'Convert', `OUTPUT_READ_FAILED: ${message}`);
      const errorObj: ConversionError = {
        code: 'OUTPUT_READ_ERROR',
        message: 'MP4 dosyası okunamadı.',
        technical: `ffmpeg.readFile() başarısız\n${message}`,
      };
      setError(errorObj);
      onStageChange?.('error');
      throw err;
    }

    onStageChange?.('complete');
    updateProgress(100, 'complete', true, null, null, videoDurationRef.current);

    // Keep all debug statuses as completed (don't reset to idle)
    updateDebugInfo?.({
      ffmpegExecStatus: 'completed',
      fileWriteStatus: 'written',
      ffmpegLoadStatus: 'loaded',
      coreJsLoadStatus: 'loaded',
      wasmLoadStatus: 'loaded',
    });

    let uint8Output: Uint8Array;
    if (outputData instanceof Uint8Array) {
      uint8Output = new Uint8Array(outputData);
    } else if (typeof outputData === 'string') {
      const encoder = new TextEncoder();
      uint8Output = encoder.encode(outputData);
    } else {
      uint8Output = new Uint8Array(outputData as ArrayBuffer);
    }
    
    const blob = new Blob([uint8Output.buffer as ArrayBuffer], { type: 'video/mp4' });
    const conversionTime = (Date.now() - startTimeRef.current) / 1000;
    const encodeTime = (Date.now() - execStartTime) / 1000; // Only FFmpeg execution time
    const inputSize = file.size; // Use original file size for accurate compression calculation
    const outputSize = blob.size;
    const compressionRatio = Math.round(((inputSize - outputSize) / inputSize) * 100);
    
    // Use the video duration from metadata or FFmpeg fallback
    const videoDurationSeconds = videoDurationRef.current ?? maxEncodedTimeRef.current;
    // Validate video duration - if it's unreasonably small compared to processed time, use processed time
    const finalVideoDuration = (videoDurationSeconds > 0 && videoDurationSeconds > maxEncodedTimeRef.current * 0.5) 
      ? videoDurationSeconds 
      : maxEncodedTimeRef.current;
    
    // Calculate bitrates based on video duration
    // Formula: actualTotalBitrate = (outputSizeBytes * 8) / videoDurationSeconds (result in bps)
    // Then convert to kbps: / 1000
    const outputSizeBytes = outputSize;
    const videoDurationSec = finalVideoDuration;
    
    const actualTotalBitrateBps = videoDurationSec > 0 ? (outputSizeBytes * 8) / videoDurationSec : null;
    const actualTotalBitrateKbps = actualTotalBitrateBps !== null ? actualTotalBitrateBps / 1000 : null;
    
    // If audio present: actualVideoBitrate = actualTotalBitrate - 128000 (128 kbps audio)
    const AUDIO_BITRATE_BPS = 128000; // 128 kbps for AAC
    const audioBitrateBps = hasAudioDetected ? AUDIO_BITRATE_BPS : 0;
    const actualVideoBitrateBps = actualTotalBitrateBps !== null ? actualTotalBitrateBps - audioBitrateBps : null;
    const actualVideoBitrateKbps = actualVideoBitrateBps !== null ? actualVideoBitrateBps / 1000 : null;
    
    // Calculate average encoding speed (video seconds per wall clock second)
    const averageSpeed = encodeTime > 0 ? (finalVideoDuration / encodeTime) : null;
    
    addLog?.('success', 'Convert', `CONVERSION_COMPLETE: ${conversionTime.toFixed(1)} sn`);
    addLog?.('info', 'Convert', `Input: ${(inputSize / (1024 * 1024)).toFixed(2)}MB`);
    addLog?.('info', 'Convert', `Output: ${(outputSizeBytes / (1024 * 1024)).toFixed(2)}MB`);
    addLog?.('info', 'Convert', `Compression: ${compressionRatio}%`);
    addLog?.('info', 'Convert', `Video süresi: ${finalVideoDuration.toFixed(2)}sn, Encode süresi: ${encodeTime.toFixed(1)}s, Hız: ${averageSpeed?.toFixed(2) ?? '-'}x`);
    if (actualTotalBitrateKbps !== null) {
      addLog?.('info', 'Convert', `Çıktı video bitrate: ${actualVideoBitrateKbps?.toFixed(0) ?? '-'}kbps, Toplam bitrate: ${actualTotalBitrateKbps.toFixed(0)}kbps`);
    }
    if (!hasAudioDetected) {
      addLog?.('info', 'Convert', 'Ses: Çıktıda ses bulunamadı');
    }

    // Update debug info with compression and encoding stats
    // Pass bitrates in bps for proper formatting by formatBitrate()
    updateDebugInfo?.({
      inputSize,
      outputSize: outputSizeBytes,
      compressionRatio,
      videoBitrate: actualVideoBitrateBps,
      audioBitrate: audioBitrateBps,
      totalBitrate: actualTotalBitrateBps,
      encodeTime,
      averageSpeed,
      totalDuration: finalVideoDuration,
      actualEngineUsed: 'ffmpeg',
    });

    // Mark conversion as succeeded before cleanup (used by log handler to ignore abort errors)
    conversionSucceeded = true;

    // Perform cleanup - keeps FFmpeg worker alive
    await cleanupResources({ terminateWorker: false, reason: 'Success' });

    return {
      blob,
      fileName: getOutputFileName(file.name),
      fileSize: blob.size,
      videoDuration: finalVideoDuration,
      conversionTime,
      inputSize,
      outputSize: outputSizeBytes,
      compressionRatio,
      // Bitrates in bps for formatBitrate() function
      videoBitrate: actualVideoBitrateBps ?? undefined,
      audioBitrate: audioBitrateBps,
      totalBitrate: actualTotalBitrateBps ?? undefined,
      encodeTime,
      averageSpeed: averageSpeed ?? undefined,
      hasAudio: hasAudioDetected,
      engine: 'ffmpeg-wasm',
    };
  }, [updateProgress, clearAllTimeouts, addLog, updateDebugInfo, normalizeError, cleanupResources, preCleanup]);

  const terminate = useCallback(async (reason: string = 'User requested') => {
    const ffmpeg = ffmpegRef.current;
    
    // Clear listeners
    if (logHandlerRef.current && ffmpeg) {
      ffmpeg.off('log', logHandlerRef.current);
      logHandlerRef.current = null;
    }
    if (progressHandlerRef.current && ffmpeg) {
      ffmpeg.off('progress', progressHandlerRef.current);
      progressHandlerRef.current = null;
    }
    
    clearAllTimeouts();
    
    // Terminate worker
    if (ffmpeg) {
      try {
        ffmpeg.terminate();
      } catch {
        // Ignore terminate errors
      }
    }
    
    ffmpegRef.current = null;
    setIsLoaded(false);
    fileDataRef.current = null;
    
    // Update status - don't reset everything, keep debug info for debugging
    updateDebugInfo?.({ 
      ffmpegExecStatus: 'error',
      cleanupStatus: 'completed',
    });
    
    setProgress({ percent: 0, time: 0, stage: 'idle', hasProgress: false, encodedTime: null, encodingSpeed: null, totalDuration: null });
  }, [clearAllTimeouts, updateDebugInfo]);

  return {
    isLoaded,
    isLoading,
    progress,
    error,
    loadFFmpeg,
    convert,
    terminate,
  };
}
