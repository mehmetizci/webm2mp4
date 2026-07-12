'use client';

import { Loader2 } from 'lucide-react';
import type { ConversionProgress as ProgressType } from '@/types/converter';
import { STAGE_LABELS } from '@/types/converter';
import { formatTime } from '@/lib/format-utils';

interface ConversionProgressProps {
  progress: ProgressType;
}

const STAGE_DESCRIPTIONS: Record<string, string> = {
  loading: 'FFmpeg motoru yükleniyor...',
  reading: 'Video dosyası işleniyor...',
  converting: 'Video H.264 codec\'e dönüştürülüyor...',
  finalizing: 'MP4 dosyası paketleniyor...',
};

export function ConversionProgress({ progress }: ConversionProgressProps) {
  const showPreparing = !progress.hasProgress && progress.stage !== 'loading' && progress.stage !== 'complete' && progress.stage !== 'error';
  const showTimeEstimate = progress.hasProgress || progress.time > 2;
  
  // Check if we have total duration info - if not, show indeterminate animation
  const hasTotalDuration = progress.totalDuration !== null && progress.totalDuration !== undefined && progress.totalDuration > 0;

  // Format encoded time (seconds to mm:ss or hh:mm:ss)
  const formatEncodedTime = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined) return '--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Format total duration (seconds to mm:ss or hh:mm:ss)
  const formatTotalDuration = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined) return '--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Calculate estimated remaining time based on encoding speed
  // Uses totalDuration if available, otherwise estimates from encoded time and speed
  const estimatedRemainingTime = (): string | null => {
    // Need at least 3 seconds elapsed and valid data
    if (progress.time < 3) {
      return 'Hesaplanıyor...';
    }
    
    const totalDuration = progress.totalDuration;
    const encodedTime = progress.encodedTime;
    const speed = progress.encodingSpeed;
    
    // Need valid total duration
    if (totalDuration === null || totalDuration === undefined || totalDuration <= 0.1) {
      return null;
    }
    
    // Need valid encoded time
    if (encodedTime === null || encodedTime === undefined || encodedTime <= 0) {
      return null;
    }
    
    // Use the speed from FFmpeg if available, otherwise calculate from elapsed time
    const effectiveSpeed = speed !== null && speed !== undefined && speed > 0 
      ? speed 
      : (encodedTime / progress.time);
    
    if (effectiveSpeed <= 0) {
      return null;
    }
    
    // Calculate remaining video time
    const remainingVideoTime = Math.max(0, totalDuration - encodedTime);
    
    // Estimate remaining wall clock time
    const remainingWallTime = remainingVideoTime / effectiveSpeed;
    
    // Don't show if remaining time is unreasonable (more than 2x current elapsed time would suggest)
    if (remainingWallTime > progress.time * 2) {
      return 'Hesaplanıyor...';
    }
    
    return formatTime(remainingWallTime);
  };

  return (
    <div className="flex flex-col items-center justify-center w-full min-h-[280px] sm:min-h-[320px] bg-slate-50/50 rounded-2xl p-6 space-y-6">
      <div className="relative">
        <div className="w-20 h-20 rounded-full">
          <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
            <circle
              cx="50"
              cy="50"
              r="45"
              fill="none"
              stroke="#E2E8F0"
              strokeWidth="6"
            />
            {hasTotalDuration ? (
              // Determinate progress bar
              <circle
                cx="50"
                cy="50"
                r="45"
                fill="none"
                stroke="#376BFC"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${progress.percent * 2.83} 283`}
                className="transition-all duration-300"
              />
            ) : (
              // Indeterminate animation - scanning effect
              <circle
                cx="50"
                cy="50"
                r="45"
                fill="none"
                stroke="#376BFC"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray="40 243"
                className="animate-[spin_1.5s_linear_infinite]"
              />
            )}
          </svg>
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-[#376BFC] animate-spin" />
        </div>
      </div>

      <div className="text-center space-y-2">
        <p className="text-slate-800 font-medium text-base">
          {showPreparing ? 'Hazırlanıyor...' : 'Videonuz MP4 formatına dönüştürülüyor'}
        </p>
        <p className="text-slate-500 text-sm">
          {showPreparing ? 'Lütfen bekleyin...' : (STAGE_LABELS[progress.stage] || 'İşleniyor...')}
        </p>
        {showPreparing ? (
          <p className="text-slate-400 text-xs">
            Dönüştürme başlatılıyor...
          </p>
        ) : STAGE_DESCRIPTIONS[progress.stage] && (
          <p className="text-slate-400 text-xs">
            {STAGE_DESCRIPTIONS[progress.stage]}
          </p>
        )}
      </div>

      <div className="w-full max-w-xs space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-slate-700 font-medium">
            {hasTotalDuration ? `${progress.percent.toFixed(0)}%` : '--%'}
          </span>
          <span className="text-slate-500">
            {showTimeEstimate ? formatTime(progress.time) : '--'}
          </span>
        </div>
        
        <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
          {hasTotalDuration ? (
            // Determinate progress bar
            <div
              className="h-full bg-[#376BFC] rounded-full transition-all duration-300 ease-out"
              style={{ width: `${progress.percent}%` }}
            />
          ) : (
            // Indeterminate animation - sliding bar
            <div className="h-full bg-[#376BFC] rounded-full animate-[slide_1.5s_ease-in-out_infinite]" />
          )}
        </div>
      </div>

      {/* Encoding stats */}
      <div className="w-full max-w-xs bg-white/60 rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Toplam video süresi:</span>
          <span className="text-slate-700 font-mono">{formatTotalDuration(progress.totalDuration)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">İşlenen video süresi:</span>
          <span className="text-slate-700 font-mono">{formatEncodedTime(progress.encodedTime)}</span>
        </div>
        {progress.encodingSpeed !== null && progress.encodingSpeed !== undefined && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Dönüşüm hızı:</span>
            <span className="text-slate-700 font-mono">{progress.encodingSpeed.toFixed(3)}x</span>
          </div>
        )}
        {(() => {
          const remaining = estimatedRemainingTime();
          if (remaining === null) return null;
          return (
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Tahmini kalan süre:</span>
              <span className={`font-mono ${remaining === 'Hesaplanıyor...' ? 'text-slate-400' : 'text-slate-700'}`}>{remaining}</span>
            </div>
          );
        })()}
      </div>

      <div className="space-y-1">
        <p className="text-xs text-slate-400 text-center max-w-xs">
          Mobil cihazlarda bu işlem birkaç dakika sürebilir.
        </p>
        <p className="text-xs text-slate-400 text-center">
          Video: H.264 • Ses: AAC
        </p>
      </div>
    </div>
  );
}
