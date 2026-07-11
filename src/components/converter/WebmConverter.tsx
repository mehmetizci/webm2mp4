'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Video, Loader2 } from 'lucide-react';
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
  VideoMetadata,
  ConversionResult as ResultType,
  ConversionError as ErrorType,
} from '@/types/converter';

export function WebmConverter() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsType>({ quality: 'balanced' });
  const [result, setResult] = useState<ResultType | null>(null);
  const [conversionError, setConversionError] = useState<ErrorType | null>(null);
  const [stage, setStage] = useState<ConversionStage>('idle');

  const { 
    isLoaded: ffmpegLoaded, 
    isLoading: ffmpegLoading, 
    progress, 
    error: ffmpegError,
    loadFFmpeg, 
    convert,
  } = useFfmpeg();

  const { metadata: videoMetadata, previewUrl: videoPreviewUrl } = useVideoMetadataState(selectedFile);

  useEffect(() => {
    if (videoMetadata) {
      setMetadata(videoMetadata);
    }
    if (videoPreviewUrl) {
      setPreviewUrl(videoPreviewUrl);
    }
  }, [videoMetadata, videoPreviewUrl]);

  const handleFileSelect = useCallback((file: File) => {
    setSelectedFile(file);
    setResult(null);
    setConversionError(null);
    setStage('idle');
  }, []);

  const handleRemoveFile = useCallback(() => {
    setSelectedFile(null);
    setMetadata(null);
    setPreviewUrl(null);
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
      if (err instanceof Error && err.message.includes('FFmpeg')) {
        setConversionError({
          code: 'FFMPEG_ERROR',
          message: 'Dönüştürücü hazırlanamadı. Lütfen sayfayı yenileyip tekrar deneyin.',
        });
      }
    }
  }, [selectedFile, ffmpegLoaded, loadFFmpeg, convert, settings.quality]);

  const handleRetry = useCallback(() => {
    setConversionError(null);
    if (selectedFile) {
      handleConvert();
    }
  }, [selectedFile, handleConvert]);

  const handleReset = useCallback(() => {
    setSelectedFile(null);
    setMetadata(null);
    setPreviewUrl(null);
    setResult(null);
    setConversionError(null);
    setStage('idle');
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const showDropzone = !selectedFile && stage === 'idle';
  const showFileDetails = selectedFile && metadata && stage === 'idle';
  const showProgress = stage !== 'idle' && stage !== 'complete' && !conversionError;
  const showResult = result && stage === 'complete';
  const showError = conversionError && stage === 'error';

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
              previewUrl={previewUrl}
              onRemove={handleRemoveFile}
            />
            
            <ConversionSettings
              settings={settings}
              onSettingsChange={setSettings}
            />

            <button
              onClick={handleConvert}
              disabled={ffmpegLoading}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-[#376BFC] text-white font-medium rounded-[10px] hover:bg-[#2563EB] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ffmpegLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Dönüştürücü hazırlanıyor...
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
