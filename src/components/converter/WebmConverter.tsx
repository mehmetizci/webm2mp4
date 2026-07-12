'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck, Video, Loader2, AlertTriangle, Lock } from 'lucide-react';
import { FileDropzone } from './FileDropzone';
import { FileDetails } from './FileDetails';
import { ConversionSettings } from './ConversionSettings';
import { ConversionProgress } from './ConversionProgress';
import { ConversionResult } from './ConversionResult';
import { ConversionError } from './ConversionError';
import { DebugPanel } from './DebugPanel';
import { EngineSelection } from './EngineSelection';
import { EngineFallback } from './EngineFallback';
import { useVideoMetadataState } from '@/hooks/useVideoMetadata';
import { useFfmpeg } from '@/hooks/useFfmpeg';
import { useDebugLog } from '@/hooks/useDebugLog';
import type { 
  ConversionSettings as SettingsType, 
  ConversionStage,
  ConversionResult as ResultType,
  ConversionError as ErrorType,
} from '@/types/converter';
import type { 
  ConversionEngine, 
  WebCodecsDetectionState,
} from '@/lib/converters/types';
import { createInitialDetectionState } from '@/lib/converters/types';

// Type alias for WakeLockSentinel
type WakeLockSentinelType = WakeLockSentinel;

const STORAGE_KEY = 'webm2mp4-preferred-engine';

function checkBrowserSupport(): { supported: boolean; message?: string } {
  if (typeof window === 'undefined') {
    return { supported: false, message: 'Tarayıcı desteklenmiyor.' };
  }
  
  if (typeof Blob === 'undefined') {
    return { supported: false, message: 'Tarayıcınız Blob API\'sini desteklemiyor.' };
  }
  
  if (typeof URL === 'undefined' || typeof URL.createObjectURL === 'undefined') {
    return { supported: false, message: 'Tarayıcınız URL API\'sini desteklemiyor.' };
  }
  
  if (typeof File === 'undefined' || typeof FileReader === 'undefined') {
    return { supported: false, message: 'Tarayıcınız File API\'sini desteklemiyor.' };
  }
  
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.instantiate === 'undefined') {
    return { supported: false, message: 'Tarayıcınız WebAssembly desteklemiyor. Lütfen güncel bir tarayıcı kullanın.' };
  }
  
  return { supported: true };
}

// Simple file validation
function validateFile(file: File): { valid: boolean; error?: string } {
  if (!file) {
    return { valid: false, error: 'Dosya mevcut değil' };
  }
  
  if (file.size === 0) {
    return { valid: false, error: 'Dosya boyutu 0 byte' };
  }
  
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension !== 'webm') {
    return { valid: false, error: 'Yalnızca .webm dosyaları desteklenir' };
  }
  
  return { valid: true };
}

export function WebmConverter() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [showFallbackPrompt, setShowFallbackPrompt] = useState(false);
  const [fallbackError, setFallbackError] = useState<string | undefined>(undefined);
  
  const [settings, setSettings] = useState<SettingsType>({ quality: 'standard' });
  const [result, setResult] = useState<ResultType | null>(null);
  const [conversionError, setConversionError] = useState<ErrorType | null>(null);
  const [stage, setStage] = useState<ConversionStage>('idle');
  const [showLongLoading, setShowLongLoading] = useState(false);
  
  // Single source of truth for WebCodecs detection
  const [webCodecsDetection, setWebCodecsDetection] = useState<WebCodecsDetectionState>(
    createInitialDetectionState()
  );
  
  // Conversion engine states
  const [selectedEngine, setSelectedEngine] = useState<ConversionEngine | null>(null);
  const [actualEngine, setActualEngine] = useState<ConversionEngine | null>(null);
  
  // WebCodecs-specific progress state
  const [webCodecsProgress, setWebCodecsProgress] = useState<{
    percent: number;
    time: number;
    stage: ConversionStage;
    hasProgress: boolean;
    encodedTime: number | null;
    encodingSpeed: number | null;
    totalDuration: number | null;
  }>({
    percent: 0,
    time: 0,
    stage: 'idle',
    hasProgress: false,
    encodedTime: null,
    encodingSpeed: null,
    totalDuration: null,
  });
  
  // Note: Render count tracking removed to prevent infinite loop
  // Use React DevTools or browser profiler for render debugging

  // Wake Lock ref to prevent screen from sleeping during conversion
  const wakeLockRef = useRef<WakeLockSentinelType | null>(null);
  
  // Object URL ref to manage download URLs properly
  const objectUrlRef = useRef<string | null>(null);
  
  // Start time ref for WebCodecs progress
  const webCodecsStartTimeRef = useRef<number>(0);

  const { debugInfo, addLog, updateDebugInfo, resetDebugInfo, setFileInfo, startElapsedTimer, stopElapsedTimer } = useDebugLog();

  const { 
    isLoaded: ffmpegLoaded, 
    isLoading: ffmpegLoading, 
    progress, 
    error: ffmpegError,
    loadFFmpeg, 
    convert,
    terminate,
  } = useFfmpeg({ addLog, updateDebugInfo });

  const { metadata, previewUrl, error: metadataError } = useVideoMetadataState(selectedFile);

  // Update debug info when detection state changes
  // Only run when capabilities are actually set (detection completed)
  useEffect(() => {
    if (!webCodecsDetection.capabilities) return;
    
    const caps = webCodecsDetection.capabilities;
    updateDebugInfo({
      webCodecsSecureContext: caps.secureContext,
      webCodecsVideoEncoder: caps.videoEncoder,
      webCodecsVideoDecoder: caps.videoDecoder,
      webCodecsVideoFrame: caps.videoFrame,
      webCodecsMediaRecorder: caps.mediaRecorder,
      webCodecsSupported: caps.h264Supported,
      webCodecsSupportReason: caps.failureReason,
      webCodecsFailureDetails: caps.errorDetails,
      webCodecsH264Supported: caps.h264Supported,
      webCodecsH264BaselineSupported: caps.h264BaselineSupported,
      webCodecsTestedCodec: caps.testedCodec,
      webCodecsHardwareAcceleration: caps.hardwareAcceleration,
      webCodecsDetectionTimeMs: caps.detectionTimeMs,
      webCodecsTimedOut: caps.timedOut,
      webCodecsCodecResults: caps.codecResults.map(r => ({
        codec: r.codec,
        profile: r.profile,
        supported: r.supported,
      })),
    });
  }, [webCodecsDetection.capabilities, updateDebugInfo]);

  // Update selected engine based on detection status
  // Use ref to track if engine has been initialized to avoid dependency issues
  const engineInitializedRef = useRef(false);
  
  useEffect(() => {
    if (engineInitializedRef.current) return;
    if (webCodecsDetection.status !== 'completed') return;
    
    engineInitializedRef.current = true;
    
    const savedEngine = localStorage.getItem(STORAGE_KEY) as ConversionEngine | null;
    
    // If WebCodecs is supported and user previously selected it, use WebCodecs
    // Otherwise default to FFmpeg WebAssembly
    if (savedEngine === 'webcodecs' && webCodecsDetection.capabilities?.h264Supported) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedEngine('webcodecs');
      updateDebugInfo({ selectedEngine: 'webcodecs' });
    } else {
      // Default to FFmpeg WebAssembly
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedEngine('ffmpeg-wasm');
      updateDebugInfo({ selectedEngine: 'ffmpeg-wasm' });
    }
  }, [webCodecsDetection.status, webCodecsDetection.capabilities?.h264Supported, updateDebugInfo]);

  // Start WebCodecs detection on mount
  useEffect(() => {
    console.log('[WebCodecs UI] WebmConverter mounted');
    
    let active = true;
    let uiWatchdog: number | null = null;
    
    async function runDetection() {
      console.log('[WebCodecs UI] Detection effect started');
      
      // Set to checking state
      setWebCodecsDetection({
        status: 'checking',
        capabilities: null,
        error: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
      
      // UI watchdog - force fail after 4 seconds
      uiWatchdog = window.setTimeout(() => {
        if (!active) return;
        console.error('[WebCodecs UI] UI watchdog timeout after 4000ms');
        setWebCodecsDetection(current => {
          if (current.status !== 'checking') return current;
          return {
            status: 'failed',
            capabilities: current.capabilities,
            error: 'WebCodecs UI detection timeout after 4000ms',
            startedAt: current.startedAt,
            updatedAt: Date.now(),
          };
        });
      }, 4000);
      
      try {
        console.log('[WebCodecs Core] getWebCodecsCapabilities entered');
        const { getWebCodecsCapabilities } = await import('@/lib/converters/webCodecsSupport');
        
        console.log('[WebCodecs Core] Promise.race started');
        const capabilities = await getWebCodecsCapabilities();
        console.log('[WebCodecs Core] Detection resolved');
        
        // Clear watchdog
        if (uiWatchdog) {
          clearTimeout(uiWatchdog);
          uiWatchdog = null;
        }
        
        if (!active) return;
        
        // Log capabilities
        console.table({
          detectionId: capabilities.detectionId,
          secureContext: capabilities.secureContext,
          videoEncoder: capabilities.videoEncoder,
          videoDecoder: capabilities.videoDecoder,
          videoFrame: capabilities.videoFrame,
          h264Supported: capabilities.h264Supported,
          failureReason: capabilities.failureReason,
        });
        
        console.log('[WebCodecs UI] Detection state set to completed');
        setWebCodecsDetection({
          status: 'completed',
          capabilities,
          error: null,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch (error) {
        if (uiWatchdog) {
          clearTimeout(uiWatchdog);
          uiWatchdog = null;
        }
        
        if (!active) return;
        
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[WebCodecs UI] Detection state set to failed:', errorMessage);
        
        setWebCodecsDetection({
          status: 'failed',
          capabilities: null,
          error: errorMessage,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
    
    runDetection();
    
    return () => {
      active = false;
      if (uiWatchdog) {
        clearTimeout(uiWatchdog);
      }
    };
  }, []);

  // Retry WebCodecs detection
  const retryWebCodecsDetection = useCallback(async () => {
    const { resetWebCodecsCache } = await import('@/lib/converters/webCodecsSupport');
    resetWebCodecsCache();
    addLog('info', 'WebCodecs', 'Tespit yeniden başlatılıyor...');
    
    // Reset engine initialization to trigger re-selection
    engineInitializedRef.current = false;
    
    // Set to checking state
    setWebCodecsDetection({
      status: 'checking',
      capabilities: null,
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    
    let uiWatchdog: number | null = null;
    const active = true;
    
    uiWatchdog = window.setTimeout(() => {
      if (!active) return;
      setWebCodecsDetection(current => {
        if (current.status !== 'checking') return current;
        return {
          status: 'failed',
          capabilities: current.capabilities,
          error: 'WebCodecs UI detection timeout after 4000ms',
          startedAt: current.startedAt,
          updatedAt: Date.now(),
        };
      });
    }, 4000);
    
    try {
      const { getWebCodecsCapabilities } = await import('@/lib/converters/webCodecsSupport');
      const capabilities = await getWebCodecsCapabilities();
      
      if (uiWatchdog) {
        clearTimeout(uiWatchdog);
        uiWatchdog = null;
      }
      
      if (!active) return;
      
      setWebCodecsDetection({
        status: 'completed',
        capabilities,
        error: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (error) {
      if (uiWatchdog) {
        clearTimeout(uiWatchdog);
        uiWatchdog = null;
      }
      
      if (!active) return;
      
      setWebCodecsDetection({
        status: 'failed',
        capabilities: null,
        error: error instanceof Error ? error.message : String(error),
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }, [addLog]);

  // Save engine preference to localStorage
  const handleEngineChange = useCallback((engine: ConversionEngine) => {
    setSelectedEngine(engine);
    localStorage.setItem(STORAGE_KEY, engine);
    updateDebugInfo({ selectedEngine: engine });
    addLog('info', 'Engine', `Motor seçildi: ${engine}`);
  }, [addLog, updateDebugInfo]);

  // Sync ffmpegError to conversionError
  useEffect(() => {
    if (ffmpegError && !conversionError) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConversionError(ffmpegError);
    }
  }, [ffmpegError, conversionError]);

  const browserCheck = typeof window !== 'undefined' 
    ? checkBrowserSupport() 
    : { supported: true };

  // Long loading timer - only show after extended loading time
  const longLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    // Clear existing timer on dependency change
    if (longLoadingTimerRef.current) {
      clearTimeout(longLoadingTimerRef.current);
      longLoadingTimerRef.current = null;
    }
    
    if (ffmpegLoading && stage === 'loading') {
      // Set timer to show long loading message
      longLoadingTimerRef.current = setTimeout(() => {
        // Only set if still loading
        if (ffmpegLoading && stage === 'loading') {
          setShowLongLoading(true);
        }
      }, 10000);
    } else {
      // Reset long loading when not loading
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowLongLoading(false);
    }
    
    return () => {
      if (longLoadingTimerRef.current) {
        clearTimeout(longLoadingTimerRef.current);
        longLoadingTimerRef.current = null;
      }
    };
  }, [ffmpegLoading, stage]);

  // Wake Lock management - request on conversion start, release on end
  const requestWakeLock = useCallback(async () => {
    if (navigator.wakeLock && !wakeLockRef.current) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        addLog?.('info', 'System', 'Ekran uyanık tutuluyor');
      } catch (err) {
        console.warn('[WakeLock] Request failed:', err);
      }
    }
  }, [addLog]);

  // Idempotent wake lock release - use sentinel.released to prevent double release
  const releaseWakeLock = useCallback(async () => {
    const sentinel = wakeLockRef.current;
    if (!sentinel) return; // Already released or never acquired
    
    wakeLockRef.current = null; // Mark as released BEFORE actual release
    
    try {
      // Only release if not already released by browser
      if (!sentinel.released) {
        await sentinel.release();
        addLog?.('info', 'System', 'Wake Lock serbest bırakıldı');
      }
    } catch (err) {
      console.warn('[WakeLock] Release failed:', err);
    }
  }, [addLog]);

  // Release wake lock when component unmounts
  useEffect(() => {
    return () => {
      const sentinel = wakeLockRef.current;
      if (sentinel && !sentinel.released) {
        sentinel.release().catch(() => {});
      }
      wakeLockRef.current = null;
    };
  }, []);

  // Re-acquire wake lock when page becomes visible again during conversion
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && isConverting && !wakeLockRef.current) {
        await requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isConverting, requestWakeLock]);

  const handleFileSelect = useCallback(async (file: File) => {
    // Simple validation
    const validation = validateFile(file);
    if (!validation.valid) {
      addLog('error', 'File', `Geçersiz dosya: ${validation.error}`);
      return;
    }
    
    // Revoke previous Object URL if exists
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      addLog('info', 'Cleanup', 'Previous Object URL revoked');
    }
    
    resetDebugInfo();
    setSelectedFile(file);
    setResult(null);
    setConversionError(null);
    setStage('idle');
    setFileInfo(file.name, file.size, file.type);
    addLog('info', 'File', `Dosya seçildi: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)}MB)`);

    // Don't pre-load FFmpeg - only load when user explicitly selects FFmpeg for conversion
    // This allows WebCodecs to be used without loading FFmpeg
    addLog('info', 'Load', 'Motor seçimi bekleniyor...');
  }, [resetDebugInfo, setFileInfo, addLog]);

  const handleRemoveFile = useCallback(() => {
    setSelectedFile(null);
    setResult(null);
    setConversionError(null);
    setStage('idle');
    resetDebugInfo();
  }, [resetDebugInfo]);

  const handleConvert = useCallback(async () => {
    if (!selectedFile) return;
    if (!selectedEngine) {
      addLog('error', 'Convert', 'Motor seçilmedi');
      return;
    }

    console.log('[Convert] Selected engine:', selectedEngine);
    console.log('[Convert] H264 supported:', webCodecsDetection.capabilities?.h264Supported);

    setConversionError(null);
    setResult(null);
    setIsConverting(true);
    resetDebugInfo();
    setFileInfo(selectedFile.name, selectedFile.size, selectedFile.type);
    startElapsedTimer();
    addLog('info', 'Convert', 'Dönüştürme başlatıldı');

    // Request wake lock to prevent screen from sleeping
    await requestWakeLock();

    try {
      // Check selected engine - only use WebCodecs if explicitly selected AND h264 is supported
      const shouldUseWebCodecs = 
        selectedEngine === 'webcodecs' && 
        webCodecsDetection.status === 'completed' && 
        webCodecsDetection.capabilities?.h264Supported === true;

      if (shouldUseWebCodecs) {
        // Use WebCodecs converter
        setActualEngine('webcodecs');
        updateDebugInfo({ actualEngineUsed: 'webcodecs' });
        
        // Always use low-level converter for accurate bitrate control
        console.log('[WebCodecs] Converter implementation: LOW_LEVEL');
        console.log('[WebCodecs] Using LOW-LEVEL converter for accurate bitrate control');
        addLog('info', 'Convert', '[WebCodecs] Converter implementation: LOW_LEVEL');
        
        const { LowLevelWebCodecsConverter } = await import('@/lib/converters/lowLevelWebCodecsConverter');
        const converter = new LowLevelWebCodecsConverter();
        
        try {
          // Initialize WebCodecs progress state
          webCodecsStartTimeRef.current = Date.now();
          setWebCodecsProgress({
            percent: 0,
            time: 0,
            stage: 'idle',
            hasProgress: false,
            encodedTime: null,
            encodingSpeed: null,
            totalDuration: null,
          });
          
          const result = await converter.convert({
            file: selectedFile,
            quality: settings.quality,
            framerate: 30,
            onProgress: (progress: { percent: number; time: number; stage: string; hasProgress?: boolean; encodedTime?: number | null; encodingSpeed?: number | null; totalDuration?: number | null }) => {
              // Update stage for all conversion stages
              if (progress.stage === 'reading' || progress.stage === 'analyzing' || 
                  progress.stage === 'initializing' || progress.stage === 'encoding' || 
                  progress.stage === 'converting' || progress.stage === 'finalizing' || 
                  progress.stage === 'complete') {
                setStage(progress.stage as ConversionStage);
              }
              
              // Update WebCodecs progress state - use actual encoded time from converter
              if (progress.percent !== undefined) {
                setWebCodecsProgress(prev => ({
                  ...prev,
                  percent: progress.percent,
                  time: progress.encodedTime ?? prev.encodedTime ?? 0,
                  hasProgress: true,
                  encodedTime: progress.encodedTime ?? null,
                  encodingSpeed: progress.encodingSpeed ?? null,
                  stage: progress.stage as ConversionStage,
                  totalDuration: prev.totalDuration ?? progress.totalDuration ?? null,
                }));
              }
            },
            onMetadata: (metadata: { totalDurationSeconds: number; width: number; height: number; frameRate: number; hasAudio: boolean; videoCodec: string; audioCodec: string | null }) => {
              console.log('[WebCodecs] Metadata received:', metadata);
              
              // Update WebCodecs progress with metadata
              setWebCodecsProgress(prev => ({
                ...prev,
                totalDuration: metadata.totalDurationSeconds,
                percent: 0,
                time: 0,
                hasProgress: true,
                // Don't override stage here - let the progress callback handle it
              }));
              
              // Also update debug info with total duration
              updateDebugInfo({
                totalDuration: metadata.totalDurationSeconds,
                metadataSource: 'mediabunny',
              });
            },
          });
          
          console.log('[WebCodecs] Conversion result:', result);
          
          // Get encoder debug info from LowLevelWebCodecsConverter
          const encoderDebugInfo = converter.getDebugInfo();
          
          // Calculate bitrates - all in bps
          const videoDuration = result.duration;
          
          // Total bitrate from file size and duration (in bps)
          const totalBitrateBps = videoDuration > 0 
            ? Math.round((result.fileSize * 8) / videoDuration)
            : null;
          
          // Video bitrate (in bps) - from output analysis or calculated
          const videoBitrateBps = result.outputAnalysis?.averageVideoBitrate 
            ?? (totalBitrateBps !== null ? totalBitrateBps - 128_000 : null); // Subtract audio bitrate
          
          // Audio bitrate (in bps)
          const audioBitrateBps = result.hasAudio ? 128_000 : 0;
          
          // Update debug info with encoder configuration from LowLevelWebCodecsConverter
          updateDebugInfo({
            lastProgressValue: 100,
            webCodecsEncoderConfig: encoderDebugInfo.encoderConfig ? {
              codec: encoderDebugInfo.encoderConfig.codec,
              targetBitrate: encoderDebugInfo.encoderConfig.bitrate,
              framerate: encoderDebugInfo.encoderConfig.framerate,
              hardwareAcceleration: encoderDebugInfo.encoderConfig.hardwareAcceleration,
              keyFrameInterval: encoderDebugInfo.encoderConfig.keyFrameInterval,
              forceTranscode: encoderDebugInfo.encoderConfig.forceTranscode,
              bitrateMode: encoderDebugInfo.encoderConfig.bitrateMode,
              latencyMode: encoderDebugInfo.encoderConfig.latencyMode,
            } : null,
            webCodecsActualBitrate: videoBitrateBps,
            webCodecsBitrateDifference: result.outputAnalysis?.bitrateDifference ?? null,
            webCodecsOutputWidth: encoderDebugInfo.outputWidth || null,
            webCodecsOutputHeight: encoderDebugInfo.outputHeight || null,
            webCodecsQualityPreset: encoderDebugInfo.qualityPreset || 'standard',
            webCodecsHardwareMode: encoderDebugInfo.hardwareMode || 'no-preference',
            webCodecsIsValid: encoderDebugInfo.isValid ?? false,
            webCodecsBitrateModeSupported: encoderDebugInfo.bitrateModeSupported ?? false,
            webCodecsBitrateModeRequested: encoderDebugInfo.bitrateModeRequested ?? 'constant',
            webCodecsConversionId: encoderDebugInfo.conversionId,
            webCodecsPipeline: 'Low Level',
            videoBitrate: videoBitrateBps,
            audioBitrate: audioBitrateBps,
            totalBitrate: totalBitrateBps,
          });
          
          // Convert to our result format (values in bps)
          const convertResult = {
            blob: result.blob,
            fileName: result.filename,
            fileSize: result.fileSize,
            videoDuration: result.duration,
            conversionTime: result.encodeTime,
            inputSize: result.inputSize,
            outputSize: result.fileSize,
            compressionRatio: result.compressionRatio,
            videoBitrate: videoBitrateBps ?? undefined, // In bps
            audioBitrate: result.hasAudio ? audioBitrateBps : 0, // In bps
            totalBitrate: totalBitrateBps ?? undefined, // In bps
            encodeTime: result.encodeTime,
            averageSpeed: result.averageSpeed ?? undefined,
            hasAudio: result.hasAudio,
            engine: 'webcodecs' as const,
          };
          
          // Update WebCodecs progress state to complete
          setWebCodecsProgress(prev => ({
            ...prev,
            percent: 100,
            encodedTime: prev.totalDuration ?? result.duration,
            totalDuration: prev.totalDuration ?? result.duration,
            encodingSpeed: result.averageSpeed ?? prev.encodingSpeed,
            stage: 'complete',
          }));
          
          setResult(convertResult);
          setStage('complete');
          addLog('success', 'Convert', 'Dönüştürme tamamlandı (WebCodecs)');
          return; // Don't fall through to FFmpeg
        } catch (webCodecsError) {
          // LowLevelWebCodecsConverter failed
          const errorMessage = webCodecsError instanceof Error ? webCodecsError.message : 'Bilinmeyen hata';
          addLog('error', 'Convert', `Düşük seviyeli WebCodecs dönüşümü başarısız: ${errorMessage}`);
          
          // Show modal to user with fallback options
          setFallbackError('Düşük seviyeli WebCodecs dönüşümü başarısız oldu: ' + errorMessage);
          setShowFallbackPrompt(true);
          
          // Don't throw - let user choose fallback option
          return;
        }
      } else {
        // Use FFmpeg WebAssembly
        setActualEngine('ffmpeg-wasm');
        updateDebugInfo({ actualEngineUsed: 'ffmpeg-wasm' });
        addLog('info', 'Convert', '[FFmpeg] Conversion started');
        console.log('[FFmpeg] Conversion started');

        // FFmpeg yüklenmemişse yükle
        if (!ffmpegLoaded) {
          setStage('loading');
          updateDebugInfo({ ffmpegLoadStatus: 'loading' });
          addLog('info', 'Load', 'FFmpeg yükleniyor...');
          const loadSuccess = await loadFFmpeg();
          if (!loadSuccess) {
            addLog('error', 'Convert', 'FFmpeg yüklenemedi');
            setStage('error');
            return;
          }
          addLog('success', 'Load', 'FFmpeg hazır');
        }

        addLog('info', 'Convert', 'Dönüştürme başlatılıyor');
        // Pass video duration and dimensions for accurate progress calculation
        const videoDuration = metadata?.duration ?? null;
        const sourceWidth = metadata?.width ?? null;
        const sourceHeight = metadata?.height ?? null;
        const convertResult = await convert(selectedFile, settings.quality, setStage, videoDuration, sourceWidth, sourceHeight);
        
        // Force progress to 100 on completion
        updateDebugInfo({ lastProgressValue: 100 });
        
        setResult(convertResult);
        addLog('success', 'Convert', 'Dönüştürme tamamlandı (FFmpeg)');
        return;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      addLog('error', 'Convert', `HATA: ${error.message}`);
      
      const conversionErrorObj = {
        code: 'CONVERSION_ERROR',
        message: 'Video dönüştürülürken bir hata oluştu.',
        technical: error.message,
      };
      
      setConversionError(conversionErrorObj);
      updateDebugInfo({
        errorCode: conversionErrorObj.code,
        errorMessage: conversionErrorObj.message,
      });
      setStage('error');
    } finally {
      setIsConverting(false);
      // Release wake lock when conversion ends
      await releaseWakeLock();
      stopElapsedTimer();
    }
  }, [selectedFile, selectedEngine, webCodecsDetection.status, webCodecsDetection.capabilities, ffmpegLoaded, loadFFmpeg, convert, settings.quality, metadata, resetDebugInfo, setFileInfo, startElapsedTimer, addLog, updateDebugInfo, stopElapsedTimer, requestWakeLock, releaseWakeLock]);

  const handleRetry = useCallback(() => {
    updateDebugInfo({ errorCode: null, errorMessage: null, errorStack: null });
    terminate();
    setConversionError(null);
    setStage('idle');
    setTimeout(() => {
      if (selectedFile) {
        handleConvert();
      }
    }, 100);
  }, [selectedFile, handleConvert, terminate, updateDebugInfo]);

  const handleReset = useCallback(() => {
    // Revoke Object URL
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      addLog('info', 'Cleanup', 'Object URL revoked on reset');
    }
    
    // Clear file references but keep FFmpeg alive
    setSelectedFile(null);
    setResult(null);
    setConversionError(null);
    setStage('idle');
    resetDebugInfo();
    
    // Note: FFmpeg worker is kept alive for faster subsequent conversions
    addLog('info', 'Reset', 'State reset, FFmpeg kept alive');
  }, [resetDebugInfo, addLog]);

  const handleFallbackRetry = useCallback((engine: ConversionEngine) => {
    setShowFallbackPrompt(false);
    setFallbackError(undefined);
    handleEngineChange(engine);
    setConversionError(null);
    setStage('idle');
    setTimeout(() => {
      if (selectedFile) {
        handleConvert();
      }
    }, 100);
  }, [handleEngineChange, selectedFile, handleConvert]);

  const handleFallbackCancel = useCallback(() => {
    setShowFallbackPrompt(false);
    setFallbackError(undefined);
  }, []);

  useEffect(() => {
    return () => {
      // Revoke Object URL on unmount
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      terminate();
    };
  }, [terminate]);

  if (browserCheck && !browserCheck.supported) {
    return (
      <div className="max-w-[760px] mx-auto px-4 sm:px-6">
        <div className="bg-white rounded-2xl border border-[rgba(15,23,42,0.08)] p-8 space-y-4 text-center shadow-sm">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-50 flex items-center justify-center">
            <AlertTriangle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-xl font-semibold text-slate-800">Tarayıcı Desteklenmiyor</h2>
          <p className="text-slate-600">{browserCheck.message}</p>
          <p className="text-sm text-slate-500">
            Lütfen Chrome, Firefox, Edge veya Safari&apos;nin güncel bir sürümünü kullanın.
          </p>
        </div>
      </div>
    );
  }

  const showDropzone = !selectedFile && stage === 'idle';
  const showFileDetails = selectedFile && stage === 'idle';
  const showProgress = stage !== 'idle' && stage !== 'complete' && !conversionError;
  const showResult = result && stage === 'complete';
  const showError = conversionError && stage === 'error';
  const showMetadataError = metadataError && !conversionError;

  return (
    <div className="max-w-[760px] mx-auto px-4 sm:px-6 py-6 sm:py-10">
      {/* Header */}
      <header className="text-center mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight mb-3">
          WebM Dosyanızı MP4&apos;e Dönüştürün
        </h1>
        <p className="text-slate-500 text-base sm:text-lg max-w-[560px] mx-auto mb-5">
          WebM videonuzu yükleyin, tarayıcınızda güvenli bir şekilde MP4 formatına dönüştürün ve hemen indirin.
        </p>
        <div className="inline-flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-100 rounded-xl">
          <Lock className="w-4 h-4 text-emerald-600" />
          <span className="text-sm text-emerald-700">Dosyanız cihazınızdan ayrılmaz • Tarayıcıda dönüştürülür</span>
        </div>
      </header>

      {/* Main Card */}
      <div className="bg-white rounded-2xl border border-[rgba(15,23,42,0.08)] p-5 sm:p-7 shadow-sm">
        {showDropzone && (
          <FileDropzone onFileSelect={handleFileSelect} />
        )}

        {showFileDetails && (
          <div className="space-y-5">
            <FileDetails
              file={selectedFile!}
              metadata={metadata}
              previewUrl={previewUrl}
            />

            <div className="bg-slate-50 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-700">Çıktı Formatı</p>
                <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-blue-50 text-blue-600 text-xs font-medium">
                  MP4
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Video: H.264 codec • Ses: AAC codec
              </p>
            </div>
            
            	            <ConversionSettings
              settings={settings}
              onSettingsChange={setSettings}
            />

            <EngineSelection
              selectedEngine={selectedEngine}
              onEngineChange={handleEngineChange}
              webCodecsDetection={webCodecsDetection}
              disabled={isConverting || ffmpegLoading}
              onRetryDetection={retryWebCodecsDetection}
            />

            <button
              onClick={handleConvert}
              disabled={!selectedFile || isConverting || ffmpegLoading}
              className="w-full flex items-center justify-center gap-2.5 py-3.5 px-5 bg-[#376BFC] text-white font-medium rounded-xl hover:bg-[#2858E0] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            >
              {ffmpegLoading || isConverting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {showLongLoading ? 'Dönüştürücü yükleniyor...' : 'Dönüştürücü hazırlanıyor...'}
                </>
              ) : (
                <>
                  <Video className="w-5 h-5" />
                  MP4&apos;e Dönüştür
                </>
              )}
            </button>
          </div>
        )}

        {showProgress && (
          <ConversionProgress 
            progress={actualEngine === 'webcodecs' ? webCodecsProgress : progress} 
          />
        )}

        {showResult && (
          <ConversionResult result={result} onReset={handleReset} />
        )}

        {showError && (
          <ConversionError error={conversionError} onRetry={handleRetry} />
        )}

        {showMetadataError && (
          <div className="bg-red-50 rounded-xl p-5 text-center">
            <p className="text-red-600 text-sm">{metadataError}</p>
            <button
              onClick={handleRemoveFile}
              className="mt-3 text-sm text-red-500 hover:text-red-700 font-medium"
            >
              Farklı bir dosya seçin
            </button>
          </div>
        )}

        {selectedFile && (
          <DebugPanel 
            debugInfo={debugInfo} 
            isVisible={true}
            webCodecsDetection={webCodecsDetection}
            selectedEngine={selectedEngine}
            actualEngine={actualEngine}
          />
        )}
      </div>

      {/* Footer Security Card */}
      <div className="mt-5 bg-white rounded-2xl border border-[rgba(15,23,42,0.08)] p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5 text-emerald-600" />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-800">Videonuz güvende</h3>
            <p className="text-sm text-slate-500">
              Seçtiğiniz video herhangi bir sunucuya yüklenmez. Tüm dönüştürme işlemi cihazınızın tarayıcısında gerçekleştirilir.
            </p>
            <ul className="space-y-1.5">
              {['Sunucuya dosya yüklenmez', 'Video saklanmaz', 'Üyelik gerekmez'].map((item) => (
                <li key={item} className="flex items-center gap-2.5 text-sm text-slate-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Fallback Prompt */}
      {showFallbackPrompt && (
        <EngineFallback
          onRetry={handleFallbackRetry}
          onCancel={handleFallbackCancel}
          error={fallbackError}
        />
      )}
    </div>
  );
}
