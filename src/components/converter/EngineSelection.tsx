'use client';

import { Zap, Globe, AlertTriangle, CheckCircle, Loader2, RefreshCw, Clock } from 'lucide-react';
import type { ConversionEngine, WebCodecsDetectionState } from '@/lib/converters/types';

interface EngineSelectionProps {
  selectedEngine: ConversionEngine | null;
  onEngineChange: (engine: ConversionEngine) => void;
  webCodecsDetection: WebCodecsDetectionState;
  disabled?: boolean;
  onRetryDetection?: () => void;
}

// WebCodecs converter is implemented using MediaRecorder + VideoEncoder
const WEBCODECS_NOT_IMPLEMENTED = false;

export function EngineSelection({
  selectedEngine,
  onEngineChange,
  webCodecsDetection,
  disabled = false,
  onRetryDetection,
}: EngineSelectionProps) {
  const { status, capabilities, error } = webCodecsDetection;
  
  const handleSelect = (engine: ConversionEngine) => {
    if (disabled) return;
    // Don't allow selecting WebCodecs if not implemented
    if (engine === 'webcodecs' && WEBCODECS_NOT_IMPLEMENTED) return;
    onEngineChange(engine);
  };

  // Show retry button when detection failed or not supported
  const showRetryButton = 
    (status === 'failed' || (status === 'completed' && !capabilities?.h264Supported)) && 
    onRetryDetection && 
    !disabled;

  // Determine WebCodecs status text
  const getWebCodecsStatus = () => {
    // If WebCodecs converter is not implemented, show placeholder message
    if (WEBCODECS_NOT_IMPLEMENTED) {
      return (
        <div className="flex items-start gap-1.5 text-slate-400 text-xs">
          <Clock className="w-3 h-3 shrink-0 mt-0.5" />
          <span>Dönüştürücü henüz uygulanmadı</span>
        </div>
      );
    }
    
    switch (status) {
      case 'idle':
      case 'checking':
        return (
          <div className="flex items-center gap-2 text-slate-500 text-xs">
            <Loader2 className="w-3 h-3 animate-spin" />
            {status === 'checking' ? 'Test ediliyor...' : 'Bekleniyor...'}
          </div>
        );
      case 'completed':
        if (capabilities?.h264Supported) {
          return (
            <div className="flex items-center gap-1.5 text-emerald-600 text-xs">
              <CheckCircle className="w-3 h-3" />
              Destekleniyor
            </div>
          );
        }
        return (
          <div className="space-y-1.5">
            <span className="text-slate-500 text-xs">Desteklenmiyor</span>
            {capabilities?.failureReason && (
              <p className="text-slate-400 text-xs">
                {capabilities.failureReason === 'H264_NOT_SUPPORTED' 
                  ? 'H.264 kodlama desteklenmiyor'
                  : capabilities.failureReason === 'MISSING_APIS'
                    ? 'WebCodecs API bulunamadı'
                    : capabilities.failureReason === 'TIMEOUT'
                      ? 'Tespit süresi aşıldı'
                      : 'Bilinmeyen hata'}
              </p>
            )}
          </div>
        );
      case 'failed':
        return (
          <div className="space-y-1.5">
            <span className="text-slate-500 text-xs">Test başarısız</span>
            {error && (
              <p className="text-amber-600 text-xs flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                <span>{error}</span>
              </p>
            )}
          </div>
        );
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-700">Dönüşüm Yöntemi</p>
        {showRetryButton && (
          <button
            onClick={onRetryDetection}
            className="flex items-center gap-1 text-xs text-[#376BFC] hover:text-[#2858E0] transition-colors"
            title="WebCodecs tespitini yeniden dene"
          >
            <RefreshCw className="w-3 h-3" />
            Tekrar Test Et
          </button>
        )}
      </div>
      
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* WebCodecs Option - Disabled if not implemented */}
        <EngineCard
          title="WebCodecs"
          description="Desteklenen modern cihazlarda daha hızlı dönüşüm."
          badge={WEBCODECS_NOT_IMPLEMENTED ? "Yakında" : "Hızlı"}
          badgeColor={WEBCODECS_NOT_IMPLEMENTED ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}
          icon={<Zap className="w-5 h-5" />}
          selected={selectedEngine === 'webcodecs'}
          supported={status === 'completed' && capabilities?.h264Supported === true}
          disabled={disabled || WEBCODECS_NOT_IMPLEMENTED || (status === 'completed' && !capabilities?.h264Supported)}
          onClick={() => handleSelect('webcodecs')}
          isPlaceholder={WEBCODECS_NOT_IMPLEMENTED}
        >
          {getWebCodecsStatus()}
        </EngineCard>

        {/* FFmpeg Option */}
        <EngineCard
          title="FFmpeg WebAssembly"
          description="Daha geniş tarayıcı ve codec uyumluluğu sunar."
          badge="Uyumlu"
          badgeColor="bg-blue-100 text-blue-700"
          icon={<Globe className="w-5 h-5" />}
          selected={selectedEngine === 'ffmpeg-wasm'}
          supported={true}
          disabled={disabled}
          onClick={() => handleSelect('ffmpeg-wasm')}
        >
          <div className="flex items-center gap-1.5 text-emerald-600 text-xs">
            <CheckCircle className="w-3 h-3" />
            Destekleniyor
          </div>
        </EngineCard>
      </div>
    </div>
  );
}

interface EngineCardProps {
  title: string;
  description: string;
  badge: string;
  badgeColor: string;
  icon: React.ReactNode;
  selected: boolean;
  supported: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
  isPlaceholder?: boolean;
}

function EngineCard({
  title,
  description,
  badge,
  badgeColor,
  icon,
  selected,
  supported,
  disabled,
  onClick,
  children,
  isPlaceholder = false,
}: EngineCardProps) {
  const baseClasses = `
    relative p-4 rounded-xl border-2 transition-all
    ${selected 
      ? 'border-[#376BFC] bg-blue-50 cursor-pointer' 
      : isPlaceholder
        ? 'border-slate-200 bg-slate-50 opacity-75 cursor-not-allowed'
        : supported && !disabled
          ? 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 cursor-pointer'
          : 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
    }
  `;

  return (
    <button
      type="button"
      className={baseClasses}
      onClick={isPlaceholder ? undefined : onClick}
      disabled={disabled || !supported}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={selected ? 'text-[#376BFC]' : 'text-slate-600'}>
            {icon}
          </span>
          <span className={`font-semibold text-sm ${selected ? 'text-[#376BFC]' : 'text-slate-800'}`}>
            {title}
          </span>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badgeColor}`}>
          {badge}
        </span>
      </div>

      {/* Description */}
      <p className="text-xs text-slate-500 mb-3 text-left">
        {description}
      </p>

      {/* Status */}
      <div className="text-left">
        {children}
      </div>

      {/* Selected indicator */}
      {selected && (
        <div className="absolute top-2 right-2">
          <div className="w-5 h-5 rounded-full bg-[#376BFC] flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>
      )}
    </button>
  );
}
