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
import { checkWebCodecsSupport } from '@/lib/converters/webCodecsSupport';
import type { 
  ConversionSettings as SettingsType, 
  ConversionStage,
  ConversionResult as ResultType,
  ConversionError as ErrorType,
} from '@/types/converter';
import type { ConversionEngine, WebCodecsSupport } from '@/lib/converters/types';

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
  
  // Conversion engine state
  const [conversionEngine, setConversionEngine] = useState<ConversionEngine>('ffmpeg');
  const [webCodecsSupport, setWebCodecsSupport] = useState<WebCodecsSupport>({
    checking: true,
    supported: false,
    reason: null,
  });

  // Wake Lock ref to prevent screen from sleeping during conversion
  const wakeLockRef = useRef<WakeLockSentinelType | null>(null);
  
  // Object URL ref to manage download URLs properly
  const objectUrlRef = useRef<string | null>(null);

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

  // Check WebCodecs support on mount
  useEffect(() => {
    const checkSupport = async () => {
      const { getWebCodecsCapabilities } = await import('@/lib/converters/webCodecsSupport');
      const capabilities = await getWebCodecsCapabilities();
      
      // Map failure reason to ConverterSupportReason
      let reason: 'WEB_CODECS_API_UNAVAILABLE' | 'H264_ENCODER_UNSUPPORTED' | 'WEB_CODECS_CHECK_FAILED' | null = null;
      if (capabilities.failureReason) {
        if (!capabilities.videoEncoder || !capabilities.videoDecoder || !capabilities.videoFrame) {
          reason = 'WEB_CODECS_API_UNAVAILABLE';
        } else if (!capabilities.h264Supported) {
          reason = 'H264_ENCODER_UNSUPPORTED';
        } else {
          reason = 'WEB_CODECS_CHECK_FAILED';
        }
      }
      
      // Update WebCodecsSupport state for UI
      setWebCodecsSupport({
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
      });
      
      // Update debug info with detailed capabilities
      updateDebugInfo({
        webCodecsSecureContext: capabilities.secureContext,
        webCodecsVideoEncoder: capabilities.videoEncoder,
        webCodecsVideoDecoder: capabilities.videoDecoder,
        webCodecsVideoFrame: capabilities.videoFrame,
        webCodecsMediaRecorder: capabilities.mediaRecorder,
        webCodecsSupported: capabilities.h264Supported,
        webCodecsSupportReason: capabilities.failureReason,
        webCodecsFailureDetails: capabilities.errorDetails,
        webCodecsH264Supported: capabilities.h264Supported,
        webCodecsH264BaselineSupported: capabilities.h264BaselineSupported,
        webCodecsTestedCodec: capabilities.testedCodec,
        webCodecsHardwareAcceleration: capabilities.hardwareAcceleration,
      });
      
      // Auto-select based on support and localStorage preference
      if (capabilities.h264Supported) {
        const savedEngine = localStorage.getItem(STORAGE_KEY);
        if (savedEngine === 'webcodecs' || !savedEngine) {
          setConversionEngine('webcodecs');
          updateDebugInfo({ selectedEngine: 'webcodecs' });
        }
      } else {
        setConversionEngine('ffmpeg');
        updateDebugInfo({ selectedEngine: 'ffmpeg' });
      }
    };
    
    checkSupport();
  }, [updateDebugInfo]);

  // Save engine preference to localStorage
  const handleEngineChange = useCallback((engine: ConversionEngine) => {
    setConversionEngine(engine);
    localStorage.setItem(STORAGE_KEY, engine);
    updateDebugInfo({ selectedEngine: engine });
    addLog('info', 'Engine', `Motor seçildi: ${engine}`);
  }, [addLog, updateDebugInfo]);

  // Sync ffmpegError to conversionError
  useEffect(() => {
    if (ffmpegError && !conversionError) {
      setConversionError(ffmpegError);
    }
  }, [ffmpegError, conversionError]);

  const browserCheck = typeof window !== 'undefined' 
    ? checkBrowserSupport() 
    : { supported: true };

  useEffect(() => {
    if (ffmpegLoading && stage === 'loading') {
      const timer = setTimeout(() => {
        setShowLongLoading(true);
      }, 10000);
      return () => clearTimeout(timer);
    } else {
      setShowLongLoading(false);
    }
  }, [ffmpegLoading, stage]);

  // Wake Lock management - request on conversion start, release on end
  const requestWakeLock = useCallback(async () => {
    if (navigator.wakeLock && !wakeLockRef.current) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        addLog?.('info', 'System', 'Ekran uyanık tutuluyor');
        
        // Handle visibility change - re-acquire wake lock if page becomes visible again
        wakeLockRef.current.addEventListener('release', () => {
          addLog?.('info', 'System', 'Wake Lock serbest bırakıldı');
        });
      } catch (err) {
        console.warn('[WakeLock] Request failed:', err);
      }
    }
  }, [addLog]);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        addLog?.('info', 'System', 'Wake Lock serbest bırakıldı');
      } catch (err) {
        console.warn('[WakeLock] Release failed:', err);
        wakeLockRef.current = null;
      }
    }
  }, [addLog]);

  // Release wake lock when component unmounts or conversion ends
  useEffect(() => {
    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
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

    // FFmpeg yüklenmemişse yükle
    if (!ffmpegLoaded) {
      addLog('info', 'Load', 'FFmpeg yükleniyor...');
      updateDebugInfo({ ffmpegLoadStatus: 'loading' });
      const loadSuccess = await loadFFmpeg();
      if (!loadSuccess) {
        addLog('error', 'Load', 'FFmpeg yüklenemedi');
        updateDebugInfo({ ffmpegLoadStatus: 'error' });
        return;
      }
      addLog('success', 'Load', 'FFmpeg hazır');
    }
  }, [ffmpegLoaded, loadFFmpeg, resetDebugInfo, setFileInfo, addLog, updateDebugInfo]);

  const handleRemoveFile = useCallback(() => {
    setSelectedFile(null);
    setResult(null);
    setConversionError(null);
    setStage('idle');
    resetDebugInfo();
  }, [resetDebugInfo]);

  const handleConvert = useCallback(async () => {
    if (!selectedFile) return;

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
      setResult(convertResult);
      addLog('success', 'Convert', 'Dönüştürme tamamlandı');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      addLog('error', 'Convert', `HATA: ${error.message}`);
      
      const conversionErrorObj = ffmpegError || {
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
  }, [selectedFile, ffmpegLoaded, ffmpegError, loadFFmpeg, convert, settings.quality, metadata, resetDebugInfo, setFileInfo, startElapsedTimer, addLog, updateDebugInfo, stopElapsedTimer, requestWakeLock, releaseWakeLock]);

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
              selectedEngine={conversionEngine}
              onEngineChange={handleEngineChange}
              webCodecsSupport={webCodecsSupport}
              disabled={isConverting || ffmpegLoading}
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
          <ConversionProgress progress={progress} />
        )}

        {showResult && (
          <ConversionResult result={result} engine={conversionEngine} onReset={handleReset} />
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
          <DebugPanel debugInfo={debugInfo} isVisible={true} />
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
