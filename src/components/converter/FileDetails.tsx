'use client';

import { Video, Clock, Maximize2, Volume2, Film, VolumeX, FileVideo } from 'lucide-react';
import type { VideoMetadata } from '@/types/converter';
import { formatFileSize, formatDuration } from '@/lib/file-utils';

interface FileDetailsProps {
  file: File;
  metadata: VideoMetadata | null;
  previewUrl: string | null;
}

export function FileDetails({ file, metadata, previewUrl }: FileDetailsProps) {
  const resolution = metadata ? `${metadata.width}x${metadata.height}` : null;
  const duration = metadata?.duration || null;

  return (
    <div className="w-full space-y-4">
      <div className="relative w-full aspect-video bg-slate-900 rounded-xl overflow-hidden">
        {previewUrl ? (
          <video
            src={previewUrl}
            className="w-full h-full object-contain"
            muted
            playsInline
            controls
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Film className="w-12 h-12 text-white/40" />
          </div>
        )}
      </div>

      <div className="bg-slate-50 rounded-xl p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <FileVideo className="w-4 h-4 text-slate-400 shrink-0" />
              <p className="text-slate-800 font-medium text-sm truncate" title={file.name}>
                {file.name}
              </p>
            </div>
            <p className="text-slate-500 text-xs mt-1.5 ml-6">
              {formatFileSize(file.size)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center shadow-sm shrink-0">
              <Clock className="w-4 h-4 text-slate-400" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400">Süre</p>
              <p className="text-xs text-slate-700 font-medium">
                {duration ? formatDuration(duration) : '--'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center shadow-sm shrink-0">
              <Maximize2 className="w-4 h-4 text-slate-400" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400">Çözünürlük</p>
              <p className="text-xs text-slate-700 font-medium">
                {resolution || '--'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center shadow-sm shrink-0">
              <Video className="w-4 h-4 text-slate-400" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400">Format</p>
              <p className="text-xs text-slate-700 font-medium">WebM</p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center shadow-sm shrink-0">
              <VolumeX className="w-4 h-4 text-slate-400" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400">Ses</p>
              <p className="text-xs text-slate-700 font-medium">--</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
          <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-[#376BFC]/10 text-[#376BFC] text-xs font-medium">
            WebM
          </span>
        </div>
      </div>
    </div>
  );
}
