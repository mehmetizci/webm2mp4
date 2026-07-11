'use client';

import { CheckCircle, Download, RefreshCw, Film } from 'lucide-react';
import type { ConversionResult as ResultType } from '@/types/converter';
import { formatFileSize } from '@/lib/file-utils';
import { formatTime } from '@/lib/format-utils';
import { downloadBlob } from '@/lib/file-utils';

interface ConversionResultProps {
  result: ResultType;
  onReset: () => void;
}

export function ConversionResult({ result, onReset }: ConversionResultProps) {
  const handleDownload = () => {
    downloadBlob(result.blob, result.fileName);
  };

  return (
    <div className="flex flex-col items-center w-full min-h-[280px] sm:min-h-[320px] bg-[#F0FDF4] rounded-[10px] p-6 space-y-6">
      <div className="w-16 h-16 rounded-full bg-[#10B981]/10 flex items-center justify-center">
        <CheckCircle className="w-10 h-10 text-[#10B981]" />
      </div>

      <div className="text-center space-y-2">
        <p className="text-[#166534] font-semibold text-lg">
          Dönüşüm tamamlandı
        </p>
        <div className="space-y-1">
          <p className="text-[#374151] font-medium text-sm">
            {result.fileName}
          </p>
          <div className="flex items-center justify-center gap-4 text-xs text-[#6B7280]">
            <span>{formatFileSize(result.fileSize)}</span>
            <span className="w-1 h-1 bg-[#D1D5DB] rounded-full" />
            <span>{formatTime(result.duration)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-[#10B981]/10 text-[#10B981] text-xs font-medium">
          <Film className="w-3 h-3 mr-1" />
          MP4
        </span>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs">
        <button
          onClick={handleDownload}
          className="flex-1 flex items-center justify-center gap-2 py-3 px-4 bg-[#10B981] text-white font-medium rounded-[10px] hover:bg-[#059669] transition-colors"
        >
          <Download className="w-4 h-4" />
          MP4 Dosyasını İndir
        </button>
        
        <button
          onClick={onReset}
          className="flex-1 flex items-center justify-center gap-2 py-3 px-4 bg-white text-[#374151] font-medium rounded-[10px] border border-[#E5E7EB] hover:bg-[#F9FAFB] transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Yeni Video Dönüştür
        </button>
      </div>
    </div>
  );
}
