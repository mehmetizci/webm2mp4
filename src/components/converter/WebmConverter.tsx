'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Video, Loader2, AlertTriangle } from 'lucide-react';
import { FileDropzone } from './FileDropzone';
import { FileDetails } from './FileDetails';
import { ConversionSettings } from './ConversionSettings';
import { ConversionProgress } from './ConversionProgress';
import { ConversionResult } from './ConversionResult';
import { ConversionError } from './ConversionError';
import { useVideoMetadataState } from '@/hooks/useVideoMetadata';
import { useFfmpeg } from '@/hooks/useFfmpeg';
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
  const [settings, setSettings] = useState<SettingsType>({ quality: 'balanced' });
  const [result, setResult] = useState<ResultType | null>(null);
  const [conversionError, setConversionError] = useState<ErrorType | null>(null);
  const [stage, setStage] = useState<ConversionStage>('idle');

  const { 
    isLoaded: ffmpegLoaded, 
    isLoading: ffmpegLoading, 
    progress, 
    loadFFmpeg, 
    analyzeMedia,
    convert,
    terminate,
  } = useFfmpeg();

  const { metadata, previewUrl, error: metadataError } = useVideoMetadataState(selectedFile);

  const browserCheck = typeof window !== 'undefined' 
    ? checkBrowserSupport() 
    : { supported: true };

  // Analyze media when file is selected and FFmpeg is loaded
  useEffect(() => {
    if (!selectedFile || !ffmpegLoaded || mediaInfo) return;
    
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsAnalyzing(true);
    analyzeMedia(selectedFile)
      .then(setMediaInfo)
      .catch(() => setMediaInfo(null))
      .finally(() => setIsAnalyzing(false));
  }, [selectedFile, ffmpegLoaded, analyzeMedia, mediaInfo]);

  const handleFileSelect = useCallback((file: File) => {
    setSelectedFile(file);
    setMediaInfo(null);
    setResult(null);
    setConversionError(null);
    setStage('idle');
  }, []);

  const handleRemoveFile = useCallback(() => {
    setSelectedFile(null);
    setMediaInfo(null);
    setResult(null);
    setConversionError(null);
    setStage('idle');
  }, []);

  const handleConvert = useCallback(async () => {
    if (!selectedFile) return;

    setConversionError(null);
    setResult(null);

    try {
      if (!ffmpegLoaded) {
        setStage('loading');
        await loadFFmpeg();
      }

      if (!ffmpegLoaded) {
        throw new Error('FFmpeg yüklenemedi');
      }

      const convertResult = await convert(selectedFile, settings.quality, setStage);
      setResult(convertResult);
    } catch (err) {
      console.error('Conversion failed:', err);
    }
  }, [selectedFile, ffmpegLoaded, loadFFmpeg, convert, settings.quality]);

  const handleRetry = useCallback(() => {
    terminate();
    setConversionError(null);
    setStage('idle');
    setTimeout(() => {
      if (selectedFile) {
        handleConvert();
      }
    }, 100);
  }, [selectedFile, handleConvert, terminate]);

  const handleReset = useCallback(() => {
    terminate();
    setSelectedFile(null);
    setMediaInfo(null);
    setResult(null);
    setConversionError(null);
    setStage('idle');
  }, [terminate]);

  useEffect(() => {
    return () => {
      terminate();
    };
  }, [terminate]);

  if (browserCheck && !browserCheck.supported) {
    return (
      <div className="w-full max-w-[720px] mx-auto px-4 py-8 space-y-6">
        <div className="bg-red-50 rounded-[10px] p-6 space-y-4 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-100 flex items-center justify-center">
            <AlertTriangle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-xl font-semibold text-red-800">Tarayıcı Desteklenmiyor</h2>
          <p className="text-red-600">{browserCheck.message}</p>
          <p className="text-sm text-red-500">
            Lütfen Chrome, Firefox, Edge veya Safari&apos;nin güncel bir sürümünü kullanın.
          </p>
        </div>
      </div>
    );
  }

  const showDropzone = !selectedFile && stage === 'idle';
  const showFileDetails = selectedFile && metadata && stage === 'idle';
  const showProgress = stage !== 'idle' && stage !== 'complete' && !conversionError;
  const showResult = result && stage === 'complete';
  const showError = conversionError && stage === 'error';
  const showMetadataError = metadataError && !conversionError;

  return (
    <div className="w-full max-w-[720px] mx-auto px-4 py-8 space-y-6">
      <div className="text-center space-y-3">
        <h1 className="text-2xl sm:text-3xl font-semibold text-[#1F2937]">
          WebM Dosyanızı MP4&apos;e Dönüştürün
        </h1>
        <p className="text-[#6B7280] text-sm sm:text-base max-w-md mx-auto">
          WebM videonuzu yükleyin, tarayıcınızda güvenli bir şekilde MP4 formatına dönüştürün ve hemen indirin.
        </p>
        <div className="flex items-center justify-center gap-2 text-xs text-[#6B7280]">
          <ShieldCheck className="w-4 h-4 text-[#10B981]" />
          <span>Dosyanız cihazınızdan ayrılmaz. Dönüşüm tamamen tarayıcınızda gerçekleştirilir.</span>
        </div>
      </div>

      <div className="bg-white rounded-[10px] shadow-sm border border-[#E5E7EB] p-4 sm:p-6 space-y-4">
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
            <div className="bg-[#F3F4F6] rounded-[10px] p-3 text-xs space-y-1">
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
              disabled={ffmpegLoading || isAnalyzing}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-[#376BFC] text-white font-medium rounded-[10px] hover:bg-[#2563EB] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ffmpegLoading || isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {isAnalyzing ? 'Video analiz ediliyor...' : 'Dönüştürücü hazırlanıyor...'}
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
      </div>

      <div className="bg-[#F9FAFB] rounded-[10px] p-4 space-y-3">
        <h3 className="text-sm font-medium text-[#374151] flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#10B981]" />
          Videonuz güvende
        </h3>
        <p className="text-xs text-[#6B7280]">
          Seçtiğiniz video herhangi bir sunucuya yüklenmez. Tüm dönüştürme işlemi cihazınızın tarayıcısında gerçekleştirilir ve işlem tamamlandığında geçici veriler temizlenir.
        </p>
        <ul className="space-y-1">
          {['Sunucuya dosya yüklenmez', 'Video saklanmaz', 'Üyelik gerekmez'].map((item) => (
            <li key={item} className="flex items-center gap-2 text-xs text-[#6B7280]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
