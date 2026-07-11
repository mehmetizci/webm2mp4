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
          <span className="text-slate-700 font-medium">{progress.percent.toFixed(0)}%</span>
          <span className="text-slate-500">
            {showTimeEstimate ? formatTime(progress.time) : '--'}
          </span>
        </div>
        
        <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-[#376BFC] rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-xs text-slate-400 text-center max-w-xs">
          Bu işlem cihazınızın performansına ve video boyutuna göre değişebilir.
        </p>
        <p className="text-xs text-slate-400 text-center">
          Video: H.264 • Ses: AAC
        </p>
      </div>
    </div>
  );
}
