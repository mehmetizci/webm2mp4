'use client';

import { Video, Clock, Maximize2, Volume2, X, Film } from 'lucide-react';
import type { VideoMetadata } from '@/types/converter';
import { formatFileSize, formatDuration } from '@/lib/file-utils';
import { formatResolution, getResolutionLabel } from '@/lib/format-utils';

interface FileDetailsProps {
  file: File;
  metadata: VideoMetadata;
  previewUrl: string | null;
  onRemove: () => void;
}

export function FileDetails({ file, metadata, previewUrl, onRemove }: FileDetailsProps) {
  return (
    <div className="w-full space-y-4">
      <div className="relative w-full aspect-video bg-black rounded-[10px] overflow-hidden">
        {previewUrl ? (
          <video
            src={previewUrl}
            className="w-full h-full object-contain"
            muted
            playsInline
            controls
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1F2937]">
            <Film className="w-12 h-12 text-white/50" />
          </div>
        )}
      </div>

      <div className="bg-[#F9FAFB] rounded-[10px] p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-[#1F2937] font-medium text-sm truncate" title={file.name}>
              {file.name}
            </p>
            <p className="text-[#6B7280] text-xs mt-1">
              {formatFileSize(file.size)}
            </p>
          </div>
          <button
            onClick={onRemove}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-[#FEE2E2] text-[#DC2626] hover:bg-[#FECACA] transition-colors flex-shrink-0"
            aria-label="Dosyayı kaldır"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-[#E5E7EB]">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#9CA3AF]" />
            <div>
              <p className="text-[10px] text-[#9CA3AF]">Süre</p>
              <p className="text-xs text-[#374151] font-medium">
                {formatDuration(metadata.duration)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Maximize2 className="w-4 h-4 text-[#9CA3AF]" />
            <div>
              <p className="text-[10px] text-[#9CA3AF]">Çözünürlük</p>
              <p className="text-xs text-[#374151] font-medium">
                {formatResolution(metadata.width, metadata.height)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-[#9CA3AF]" />
            <div>
              <p className="text-[10px] text-[#9CA3AF]">Format</p>
              <p className="text-xs text-[#374151] font-medium">WebM</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-[#9CA3AF]" />
            <div>
              <p className="text-[10px] text-[#9CA3AF]">Ses</p>
              <p className="text-xs text-[#374151] font-medium">
                {metadata.hasAudio === null ? 'Bilinmiyor' : metadata.hasAudio ? 'Var' : 'Yok'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-2 border-t border-[#E5E7EB]">
          <span className="inline-flex items-center px-2 py-1 rounded-full bg-[#376BFC]/10 text-[#376BFC] text-xs font-medium">
            WebM
          </span>
          {getResolutionLabel(metadata.width, metadata.height) !== 'Düşük' && (
            <span className="inline-flex items-center px-2 py-1 rounded-full bg-[#10B981]/10 text-[#10B981] text-xs font-medium">
              {getResolutionLabel(metadata.width, metadata.height)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
