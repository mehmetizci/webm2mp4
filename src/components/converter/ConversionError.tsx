'use client';

import { AlertCircle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import type { ConversionError as ErrorType } from '@/types/converter';

interface ConversionErrorProps {
  error: ErrorType;
  onRetry: () => void;
}

export function ConversionError({ error, onRetry }: ConversionErrorProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="flex flex-col items-center justify-center w-full min-h-[280px] sm:min-h-[320px] bg-red-50/50 rounded-2xl p-6 space-y-6">
      <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
        <AlertCircle className="w-10 h-10 text-red-500" />
      </div>

      <div className="text-center space-y-2">
        <p className="text-red-700 font-semibold text-lg">
          Dönüşüm başarısız
        </p>
        <p className="text-slate-600 text-sm max-w-xs">
          {error.message}
        </p>
      </div>

      {error.technical && (
        <div className="w-full max-w-xs">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center justify-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors mx-auto"
          >
            {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {showDetails ? 'Detayları gizle' : 'Teknik detayları göster'}
          </button>
          {showDetails && (
            <div className="mt-3 p-3 bg-red-100/50 rounded-xl text-xs text-red-700 font-mono break-all">
              <p className="font-semibold">Hata Kodu: {error.code}</p>
              <p className="mt-2 break-normal">{error.technical}</p>
            </div>
          )}
        </div>
      )}

      <button
        onClick={onRetry}
        className="flex items-center justify-center gap-2.5 py-3 px-6 bg-[#376BFC] text-white font-medium rounded-xl hover:bg-[#2858E0] active:scale-[0.98] transition-all"
      >
        <RefreshCw className="w-5 h-5" />
        Tekrar Dene
      </button>
    </div>
  );
}
