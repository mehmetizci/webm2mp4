'use client';

import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import type { ConversionEngine } from '@/lib/converters/types';

interface EngineFallbackProps {
  onRetry: (engine: ConversionEngine) => void;
  onCancel: () => void;
  error?: string;
}

export function EngineFallback({
  onRetry,
  onCancel,
  error,
}: EngineFallbackProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-5">
        {/* Icon */}
        <div className="flex justify-center">
          <div className="w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center">
            <AlertTriangle className="w-7 h-7 text-amber-500" />
          </div>
        </div>

        {/* Title */}
        <div className="text-center space-y-2">
          <h3 className="text-lg font-semibold text-slate-800">
            Dönüşüm Tamamlanamadı
          </h3>
          <p className="text-sm text-slate-500">
            WebCodecs yöntemiyle dönüşüm tamamlanamadı. 
            FFmpeg WebAssembly ile tekrar denemek ister misiniz?
          </p>
          {error && (
            <p className="text-xs text-slate-400 font-mono bg-slate-100 p-2 rounded-lg">
              {error}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-slate-200 text-slate-600 font-medium text-sm hover:bg-slate-50 transition-colors"
          >
            <X className="w-4 h-4" />
            Vazgeç
          </button>
          <button
            onClick={() => onRetry('ffmpeg-wasm')}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#376BFC] text-white font-medium text-sm hover:bg-[#2858E0] transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            FFmpeg ile Tekrar Dene
          </button>
        </div>
      </div>
    </div>
  );
}
