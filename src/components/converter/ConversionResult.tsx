'use client';

import { CheckCircle, Download, RefreshCw, Film, ArrowDownCircle, Clock, Gauge, Zap, Globe, Volume, VolumeX } from 'lucide-react';
import type { ConversionResult as ResultType } from '@/types/converter';
import { downloadBlob } from '@/lib/file-utils';
import { formatBitrate } from '@/lib/formatBitrate';

interface ConversionResultProps {
  result: ResultType;
  onReset: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatVideoDuration(seconds: number): string {
  return `${seconds.toFixed(1)} sn`;
}

function formatConversionTime(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)} sn`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins} dk ${secs} sn`;
}

export function ConversionResult({ result, onReset }: ConversionResultProps) {
  const handleDownload = () => {
    downloadBlob(result.blob, result.fileName);
  };

  const engineLabel = result.engine === 'webcodecs' ? 'WebCodecs' : 'FFmpeg WebAssembly';
  const EngineIcon = result.engine === 'webcodecs' ? Zap : Globe;
  const AudioIcon = result.hasAudio ? Volume : VolumeX;

  return (
    <div className="flex flex-col items-center w-full min-h-[280px] sm:min-h-[320px] bg-emerald-50/50 rounded-2xl p-6 space-y-6">
      <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
        <CheckCircle className="w-10 h-10 text-emerald-600" />
      </div>

      <div className="text-center space-y-2">
        <p className="text-emerald-700 font-semibold text-lg">
          Dönüşüm tamamlandı
        </p>
        <div className="space-y-1">
          <p className="text-slate-700 font-medium text-sm">
            {result.fileName}
          </p>
          <div className="flex items-center justify-center gap-3 text-xs text-slate-500">
            <span>{formatBytes(result.fileSize)}</span>
            <span className="w-1 h-1 bg-slate-300 rounded-full" />
            <span>{formatVideoDuration(result.videoDuration)}</span>
          </div>
        </div>
      </div>

      {/* Engine Badge */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 text-xs font-medium">
          <EngineIcon className="w-3.5 h-3.5 mr-1.5" />
          {engineLabel}
        </span>
        <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-emerald-100 text-emerald-700 text-xs font-medium">
          <Film className="w-3.5 h-3.5 mr-1.5" />
          MP4
        </span>
      </div>

      {/* Compression Stats */}
      {result.inputSize > 0 && result.outputSize > 0 && (
        <div className="w-full max-w-xs bg-white rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <ArrowDownCircle className="w-4 h-4 text-emerald-600" />
            Dönüşüm Özeti
          </div>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div className="space-y-1">
              <span className="text-slate-500">Input</span>
              <p className="font-mono text-slate-700">{formatBytes(result.inputSize)}</p>
            </div>
            <div className="space-y-1">
              <span className="text-slate-500">Output</span>
              <p className="font-mono text-slate-700">{formatBytes(result.outputSize)}</p>
            </div>
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
            <span className="text-sm font-medium text-emerald-700">Sıkıştırma</span>
            <span className="text-lg font-bold text-emerald-700">{result.compressionRatio}%</span>
          </div>
          
          {/* Duration Stats */}
          <div className="pt-2 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 text-slate-500">
                <Film className="w-3.5 h-3.5" />
                <span>Video Süresi</span>
              </div>
              <span className="font-mono text-slate-700">{formatVideoDuration(result.videoDuration)}</span>
            </div>
            {result.conversionTime && (
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-slate-500">
                  <Clock className="w-3.5 h-3.5" />
                  <span>Dönüşüm Süresi</span>
                </div>
                <span className="font-mono text-slate-700">{formatConversionTime(result.conversionTime)}</span>
              </div>
            )}
            {result.averageSpeed && (
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-slate-500">
                  <Gauge className="w-3.5 h-3.5" />
                  <span>Ortalama Hız</span>
                </div>
                <span className="font-mono text-slate-700">{result.averageSpeed.toFixed(2)}x</span>
              </div>
            )}
            {/* Audio status */}
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 text-slate-500">
                <AudioIcon className="w-3.5 h-3.5" />
                <span>Ses</span>
              </div>
              <span className="font-mono text-slate-700">{result.hasAudio ? 'Var' : 'Yok'}</span>
            </div>
          </div>
          
          {/* Bitrate Stats - All values are in bps */}
          {(result.totalBitrate || result.videoBitrate) && (
            <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 space-y-1">
              {result.videoBitrate && (
                <div className="flex justify-between">
                  <span>Video Bitrate</span>
                  <span className="font-mono text-slate-700">{formatBitrate(result.videoBitrate)}</span>
                </div>
              )}
              {result.audioBitrate !== undefined && result.audioBitrate > 0 && (
                <div className="flex justify-between">
                  <span>Ses Bitrate</span>
                  <span className="font-mono text-slate-700">{formatBitrate(result.audioBitrate)}</span>
                </div>
              )}
              {result.totalBitrate && (
                <div className="flex justify-between">
                  <span>Toplam Bitrate</span>
                  <span className="font-mono text-slate-700">{formatBitrate(result.totalBitrate)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs">
        <button
          onClick={handleDownload}
          className="flex-1 flex items-center justify-center gap-2.5 py-3 px-5 bg-[#10B981] text-white font-medium rounded-xl hover:bg-[#0EA573] active:scale-[0.98] transition-all"
        >
          <Download className="w-5 h-5" />
          MP4 Dosyasını İndir
        </button>
        
        <button
          onClick={onReset}
          className="flex-1 flex items-center justify-center gap-2.5 py-3 px-5 bg-white text-slate-700 font-medium rounded-xl border border-slate-200 hover:bg-slate-50 active:scale-[0.98] transition-all"
        >
          <RefreshCw className="w-5 h-5" />
          Yeni Video Dönüştür
        </button>
      </div>
    </div>
  );
}
