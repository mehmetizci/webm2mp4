'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck, Video, Loader2, AlertTriangle } from 'lucide-react';
import { FileDropzone } from './FileDropzone';
import { FileDetails } from './FileDetails';
import { ConversionSettings } from './ConversionSettings';
import { ConversionProgress } from './ConversionProgress';
import { ConversionResult } from './ConversionResult';
import { ConversionError } from './ConversionError';
import { DebugPanel } from './DebugPanel';
import { useVideoMetadataState } from '@/hooks/useVideoMetadata';
import { useFfmpeg } from '@/hooks/useFfmpeg';
import { useDebugLog } from '@/hooks/useDebugLog';
import type { 
  ConversionSettings as SettingsType, 
  ConversionStage,
  ConversionResult as ResultType,
  ConversionError as ErrorType,
  MediaInfo,
} from '@/types/converter';

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

export function WebmConverter() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [currentFileKey, setCurrentFileKey] = useState<string | null>(null);
  
  // Ref to track the current analysis promise
  const mediaAnalysisPromiseRef = useRef<Promise<MediaInfo | null> | null>(null);
  
  const [settings, setSettings] = useState<SettingsType>({ quality: 'balanced' });
  const [result, setResult] = useState<ResultType | null>(null);
  const [conversionError, setConversionError] = useState<ErrorType | null>(null);
  const [stage, setStage] = useState<ConversionStage>('idle');
  const [showLongLoading, setShowLongLoading] = useState(false);

  // Debug logging
  const { debugInfo, addLog, updateDebugInfo, resetDebugInfo, setFileInfo, startElapsedTimer, stopElapsedTimer } = useDebugLog();

  const { 
    isLoaded: ffmpegLoaded, 
    isLoading: ffmpegLoading, 
    progress, 
    loadFFmpeg, 
    analyzeMedia,
    convert,
    terminate,
  } = useFfmpeg({ addLog, updateDebugInfo });

  const { metadata, previewUrl, error: metadataError } = useVideoMetadataState(selectedFile);

  const browserCheck = typeof window !== 'undefined' 
    ? checkBrowserSupport() 
    : { supported: true };

  // Show long loading message after 10 seconds of FFmpeg loading
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

  // Analyze media when file is selected and FFmpeg is loaded
  useEffect(() => {
    if (!selectedFile || !ffmpegLoaded || mediaInfo) return;
    
    // Set file info in debug
    setFileInfo(selectedFile.name, selectedFile.size, selectedFile.type);
    addLog('info', 'File', `Dosya seçildi: ${selectedFile.name}`);
    
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsAnalyzing(true);
    updateDebugInfo({ mediaAnalysisStatus: 'analyzing' });
    addLog('info', 'Media', 'Medya analizi başlatılıyor');
    
    analyzeMedia(selectedFile)
      .then((info) => {
        setMediaInfo(info);
        updateDebugInfo({ mediaAnalysisStatus: 'completed' });
        addLog('success', 'Media', `Medya analizi tamamlandı: ${info.resolution || 'bilinmiyor'}`);
      })
      .catch((err) => {
        setMediaInfo(null);
        updateDebugInfo({ mediaAnalysisStatus: 'error' });
        addLog('error', 'Media', `Medya analizi hatası: ${err}`);
      })
      .finally(() => {
        setIsAnalyzing(false);
      });
  }, [selectedFile, ffmpegLoaded, analyzeMedia, mediaInfo, setFileInfo, addLog, updateDebugInfo]);

  const handleFileSelect = useCallback((file: File) => {
    resetDebugInfo();
    setSelectedFile(file);
    setMediaInfo(null);
    setResult(null);
    setConversionError(null);
    setStage('idle');
  }, [resetDebugInfo]);

  const handleRemoveFile = useCallback(() => {
    setSelectedFile(null);
    setMediaInfo(null);
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
    addLog('info', 'Conversion', 'Dönüştürme başlatıldı');

    try {
      // Wait for media analysis if still in progress
      let resolvedMediaInfo = mediaInfo;
      if (!resolvedMediaInfo && mediaAnalysisPromiseRef.current) {
        addLog('info', 'Conversion', 'Devam eden medya analizi bekleniyor...');
        resolvedMediaInfo = await mediaAnalysisPromiseRef.current;
        if (resolvedMediaInfo) {
          addLog('info', 'Media', 'Analiz sonucu dönüşüme aktarıldı');
        }
      }

      // Final check for mediaInfo
      if (!resolvedMediaInfo) {
        throw new Error('Video analizi tamamlanamadı. Lütfen dosyayı yeniden seçin.');
      }

      addLog('info', 'Conversion', `Medya bilgisi hazır: ${resolvedMediaInfo.resolution || 'bilinmiyor'}`);

      // FFmpeg zaten yüklü mü kontrol et (state)
      if (!ffmpegLoaded) {
        setStage('loading');
        updateDebugInfo({ ffmpegLoadStatus: 'loading' });
        addLog('info', 'FFmpeg', 'FFmpeg yükleniyor...');
        const loadSuccess = await loadFFmpeg();
        if (!loadSuccess) {
          addLog('error', 'Conversion', 'FFmpeg yüklenemedi - loadFFmpeg() false döndü');
          setStage('error');
          return;
        }
        addLog('success', 'Conversion', 'FFmpeg başarıyla yüklendi');
      }

      addLog('info', 'Conversion', 'Dönüştürme başlatılıyor');
      const convertResult = await convert(selectedFile, settings.quality, resolvedMediaInfo, setStage);
      setResult(convertResult);
      addLog('success', 'Conversion', 'Dönüştürme tamamlandı');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      addLog('error', 'Conversion', `YAKALANAN HATA: ${error.message}`, { stack: error.stack });
      updateDebugInfo({
        errorMessage: error.message,
        errorStack: error.stack,
      });
      setStage('error');
    } finally {
      setIsConverting(false);
      stopElapsedTimer();
    }
  }, [selectedFile, ffmpegLoaded, loadFFmpeg, convert, settings.quality, mediaInfo, resetDebugInfo, setFileInfo, startElapsedTimer, addLog, updateDebugInfo, stopElapsedTimer]);

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
    terminate();
    setSelectedFile(null);
    setMediaInfo(null);
    setResult(null);
    setConversionError(null);
    setStage('idle');
    resetDebugInfo();
  }, [terminate, resetDebugInfo]);

  useEffect(() => {
    return () => {
      terminate();
    };
  }, [terminate]);

  if (browserCheck && !browserCheck.supported) {
    return (
      <div className="w-full max-w-[720px] mx-auto">
        <div className="bg-red-50 rounded-[10px] p-6 space-y-4 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-100 flex items-center justify-center">
            <AlertTriangle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-xl font-semibold text-red-800">Taray캇c캇 Desteklenmiyor</h2>
          <p className="text-red-600">{browserCheck.message}</p>
          <p className="text-sm text-red-500">
            L체tfen Chrome, Firefox, Edge veya Safari&apos;nin g체ncel bir s체r체m체n체 kullan캇n.
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
    <div className="w-full max-w-[720px] mx-auto">
      <div className="text-center mb-6 px-5">
        <h1 className="text-[32px] sm:text-[42px] font-bold text-[#1F2937] leading-[38px] sm:leading-[50px] tracking-tight">
          WebM Dosyanızı MP4'e Dönüştürün
        </h1>
        <p className="text-[17px] leading-[26px] text-[#6B7280] max-w-[640px] mx-auto mt-3">
          WebM videonuzu y체kleyin, tarayıcınızda güvenli bir şekilde MP4 formatına dönüştürün ve hemen indirin.
        </p>
        <div className="inline-flex items-center gap-2 mt-4 px-3 py-2 bg-[#ECFDF5] border border-[#10B981]/20 rounded-[10px]">
          <ShieldCheck className="w-4 h-4 text-[#10B981]" />
          <span className="text-[14px] text-[#065F46] leading-tight">Dosyanız cihazınızdan ayr캇lmaz. Dönüşüm tamamen tarayıcınızda ger챌ekle힊tirilir.</span>
        </div>
      </div>

      <div className="mx-4 sm:mx-0">
        <div className="bg-white rounded-[10px] border border-[#E5E7EB] p-5 sm:p-7 space-y-4">
        {showDropzone && (
          <FileDropzone onFileSelect={handleFileSelect} />
        )}

        {showFileDetails && (
          <div className="space-y-4">
            <FileDetails
              file={selectedFile!}
              metadata={metadata}
              mediaInfo={isAnalyzing ? null : mediaInfo}
              previewUrl={previewUrl}
            />

            {/* Output format info */}
            <div className="bg-[#F9FAFB] rounded-[10px] p-3 text-xs space-y-1">
              <p className="font-medium text-[#374151]">Çıktı Formatı: MP4</p>
              <p className="text-[#6B7280]">
                Video: H.264 | Ses: AAC
              </p>
            </div>
            
            <ConversionSettings
              settings={settings}
              onSettingsChange={setSettings}
            />

            <button
              onClick={handleConvert}
              disabled={!selectedFile || isAnalyzing || !mediaInfo || isConverting || ffmpegLoading}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-[#376BFC] text-white font-medium rounded-[10px] hover:bg-[#2563EB] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ffmpegLoading || isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {isAnalyzing ? 'Video analiz ediliyor...' : showLongLoading ? 'Dönüştürücü yükleniyor...' : 'Dönüştürücü hazırlanıyor...'}
                </>
              ) : (
                <>
                  <Video className="w-4 h-4" />
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
          <ConversionResult result={result} onReset={handleReset} />
        )}

        {showError && (
          <ConversionError error={conversionError} onRetry={handleRetry} />
        )}

        {showMetadataError && (
          <div className="bg-red-50 rounded-[10px] p-4 text-center">
            <p className="text-red-600 text-sm">{metadataError}</p>
            <button
              onClick={handleRemoveFile}
              className="mt-2 text-sm text-red-500 hover:text-red-700 underline"
            >
              Farklı bir dosya seçin
            </button>
          </div>
        )}

        {/* Debug Panel */}
        {selectedFile && (
          <DebugPanel debugInfo={debugInfo} isVisible={true} />
        )}
      </div>
      </div>

      {/* Footer Info */}
      <div className="mt-4 mx-4 sm:mx-0">
        <div className="bg-white rounded-[10px] border border-[#E5E7EB] p-4 space-y-2">
          <h3 className="text-[14px] font-medium text-[#374151] flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#10B981]" />
          Videonuz güvende
        </h3>
        <p className="text-[13px] text-[#6B7280]">
          Seçtiğiniz video herhangi bir sunucuya y체klenmez. Tüm dönüştürme işlemi cihazınızın tarayıcısında ger챌ekle힊tirilir ve işlem tamamlandığında ge챌ici veriler temizlenir.
        </p>
        <ul className="space-y-1">
          {['Sunucuya dosya yüklenmez', 'Video saklanmaz', 'Üyelik gerekmez'].map((item) => (
            <li key={item} className="flex items-center gap-2 text-[13px] text-[#6B7280]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
              {item}
            </li>
          ))}
        </ul>
        </div>
      </div>
    </div>
  );
}
