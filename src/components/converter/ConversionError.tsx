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
    <div className="flex flex-col items-center justify-center w-full min-h-[280px] sm:min-h-[320px] bg-[#FEF2F2] rounded-[10px] p-6 space-y-6">
      <div className="w-16 h-16 rounded-full bg-[#DC2626]/10 flex items-center justify-center">
        <AlertCircle className="w-10 h-10 text-[#DC2626]" />
      </div>

      <div className="text-center space-y-2">
        <p className="text-[#991B1B] font-semibold text-lg">
          Dönüşüm başarısız
        </p>
        <p className="text-[#374151] text-sm max-w-xs">
          {error.message}
        </p>
      </div>

      {/* Technical error details for debugging */}
      {error.technical && (
        <div className="w-full max-w-xs">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center justify-center gap-1 text-xs text-[#6B7280] hover:text-[#374151] transition-colors mx-auto"
          >
            {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showDetails ? 'Detayları gizle' : 'Teknik detayları göster'}
          </button>
          {showDetails && (
            <div className="mt-2 p-2 bg-[#FEE2E2] rounded-[6px] text-xs text-[#991B1B] font-mono break-all">
              <p className="font-semibold">Hata Kodu: {error.code}</p>
              <p className="mt-1 break-normal">{error.technical}</p>
            </div>
          )}
        </div>
      )}

      <button
        onClick={onRetry}
        className="flex items-center justify-center gap-2 py-3 px-6 bg-[#376BFC] text-white font-medium rounded-[10px] hover:bg-[#2563EB] transition-colors"
      >
        <RefreshCw className="w-4 h-4" />
        Tekrar Dene
      </button>
    </div>
  );
}
