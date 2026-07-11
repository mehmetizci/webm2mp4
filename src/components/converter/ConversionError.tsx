'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';
import type { ConversionError as ErrorType } from '@/types/converter';

interface ConversionErrorProps {
  error: ErrorType;
  onRetry: () => void;
}

export function ConversionError({ error, onRetry }: ConversionErrorProps) {
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
