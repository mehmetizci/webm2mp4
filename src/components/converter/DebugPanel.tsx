'use client';

import { ChevronDown, ChevronUp, Bug, AlertTriangle, CheckCircle, XCircle, Info, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { ConversionDebugInfo, DebugLogEntry } from '@/hooks/useDebugLog';

interface DebugPanelProps {
  debugInfo: ConversionDebugInfo;
  isVisible: boolean;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins > 0) {
    return `${mins} dk ${secs} sn`;
  }
  return `${secs} sn`;
}

function formatEncodedTime(seconds: number | null): string {
  if (seconds === null) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.padStart(5, '0')}`;
  }
  return `${m}:${s.padStart(5, '0')}`;
}

function StatusBadge({ status }: { status: string }) {
  const getStatusConfig = () => {
    switch (status) {
      case 'loaded':
      case 'completed':
      case 'written':
        return { icon: CheckCircle, color: 'text-emerald-600 bg-emerald-50', label: 'Tamamlandı' };
      case 'loading':
      case 'analyzing':
      case 'validating':
      case 'writing':
      case 'running':
        return { icon: Loader2, color: 'text-blue-600 bg-blue-50', label: 'İşleniyor', animate: true };
      case 'error':
        return { icon: XCircle, color: 'text-red-600 bg-red-50', label: 'Hata' };
      case 'timeout':
        return { icon: XCircle, color: 'text-orange-600 bg-orange-50', label: 'Zaman aşımı' };
      default:
        return { icon: Info, color: 'text-slate-400 bg-slate-50', label: 'Bekliyor' };
    }
  };

  const config = getStatusConfig();
  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${config.color}`}>
      <Icon className={`w-3 h-3 ${config.animate ? 'animate-spin' : ''}`} />
      {config.label}
    </span>
  );
}

function LogEntry({ entry }: { entry: DebugLogEntry }) {
  const getLevelIcon = () => {
    switch (entry.level) {
      case 'success':
        return <CheckCircle className="w-3 h-3 text-emerald-600" />;
      case 'warning':
        return <AlertTriangle className="w-3 h-3 text-amber-600" />;
      case 'error':
        return <XCircle className="w-3 h-3 text-red-600" />;
      default:
        return <Info className="w-3 h-3 text-blue-600" />;
    }
  };

  return (
    <div className={`flex items-start gap-2 py-1.5 border-b border-slate-100 last:border-0 ${
      entry.level === 'error' ? 'bg-red-50 -mx-2 px-2 rounded-lg' : ''
    }`}>
      <span className="text-xs text-slate-400 font-mono shrink-0">{entry.timestamp}</span>
      {getLevelIcon()}
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-slate-600">[{entry.step}]</span>{' '}
        <span className="text-xs text-slate-500 break-all">{entry.message}</span>
      </div>
    </div>
  );
}

function DebugSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{title}</h4>
      <div className="bg-slate-50 rounded-xl p-3 space-y-1.5 text-xs">
        {children}
      </div>
    </div>
  );
}

function DebugRow({ label, value, status }: { label: string; value: string | null; status?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-slate-700 font-mono break-all">{value ?? '-'}</span>
        {status && <StatusBadge status={status} />}
      </div>
    </div>
  );
}

export function DebugPanel({ debugInfo, isVisible }: DebugPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  if (!isVisible) return null;

  return (
    <div className="mt-5 border border-slate-200 rounded-xl overflow-hidden bg-white">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 bg-slate-50 hover:bg-slate-100 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Bug className="w-4 h-4 text-slate-500" />
          <span className="text-sm font-medium text-slate-700">Debug Bilgileri</span>
          <span className="text-xs text-slate-400">({debugInfo.logs.length} log)</span>
        </div>
        {isOpen ? (
          <ChevronUp className="w-4 h-4 text-slate-400" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-400" />
        )}
      </button>

      {isOpen && (
        <div className="p-4 space-y-4 max-h-[500px] overflow-y-auto">
          {/* Environment Info */}
          <DebugSection title="Çevre Bilgileri">
            <div className="text-slate-500 break-all font-mono bg-white p-2 rounded-lg border border-slate-100">
              {debugInfo.userAgent}
            </div>
          </DebugSection>

          {/* File Info */}
          <DebugSection title="Dosya Bilgileri">
            <DebugRow label="Dosya Adı" value={debugInfo.fileName} />
            <DebugRow label="Dosya Boyutu" value={formatBytes(debugInfo.fileSize)} />
            <DebugRow label="MIME Type" value={debugInfo.fileMimeType} />
          </DebugSection>

          {/* Conversion Engine Info */}
          <DebugSection title="Dönüşüm Motoru">
            <DebugRow 
              label="Seçilen Motor" 
              value={debugInfo.selectedEngine === 'webcodecs' ? 'WebCodecs' : debugInfo.selectedEngine === 'ffmpeg' ? 'FFmpeg WebAssembly' : null} 
            />
            <DebugRow 
              label="WebCodecs API Mevcut" 
              value={debugInfo.webCodecsSupported ? 'Evet' : 'Hayır'} 
              status={debugInfo.webCodecsSupported ? 'completed' : 'error'}
            />
            <DebugRow 
              label="H.264 Encoder" 
              value={debugInfo.webCodecsH264Supported === true ? 'Destekleniyor' : debugInfo.webCodecsH264Supported === false ? 'Desteklenmiyor' : null} 
              status={debugInfo.webCodecsH264Supported === true ? 'completed' : debugInfo.webCodecsH264Supported === false ? 'error' : undefined}
            />
            {debugInfo.webCodecsHardwareAcceleration && (
              <DebugRow 
                label="Hardware Acceleration" 
                value={debugInfo.webCodecsHardwareAcceleration} 
              />
            )}
            <DebugRow 
              label="Gerçekte Kullanılan Motor" 
              value={debugInfo.actualEngineUsed === 'webcodecs' ? 'WebCodecs' : debugInfo.actualEngineUsed === 'ffmpeg' ? 'FFmpeg WebAssembly' : null} 
            />
          </DebugSection>

          {/* Conversion Status */}
          <DebugSection title="Dönüşüm Durumu">
            <DebugRow label="FFmpeg Yükleme" value={debugInfo.ffmpegLoadStatus} status={debugInfo.ffmpegLoadStatus} />
            <DebugRow label="Core JS Yükleme" value={debugInfo.coreJsLoadStatus} status={debugInfo.coreJsLoadStatus} />
            <DebugRow label="WASM Yükleme" value={debugInfo.wasmLoadStatus} status={debugInfo.wasmLoadStatus} />
            <DebugRow label="Dosya Yazma" value={debugInfo.fileWriteStatus} status={debugInfo.fileWriteStatus} />
            <DebugRow label="FFmpeg Dönüşüm" value={debugInfo.ffmpegExecStatus} status={debugInfo.ffmpegExecStatus} />
          </DebugSection>

          {/* Cleanup Validation */}
          {debugInfo.cleanupValidation && (
            <DebugSection title="Cleanup Doğrulama">
              <DebugRow 
                label="Input Silindi" 
                value={debugInfo.cleanupValidation.inputDeleted ? '✓' : '✗'} 
                status={debugInfo.cleanupValidation.inputDeleted ? 'completed' : 'error'}
              />
              <DebugRow 
                label="Output Silindi" 
                value={debugInfo.cleanupValidation.outputDeleted ? '✓' : '✗'} 
                status={debugInfo.cleanupValidation.outputDeleted ? 'completed' : 'error'}
              />
              <DebugRow 
                label="Listeners Kaldırıldı" 
                value={debugInfo.cleanupValidation.listenersRemoved ? '✓' : '✗'} 
                status={debugInfo.cleanupValidation.listenersRemoved ? 'completed' : 'error'}
              />
              <DebugRow 
                label="Timers Temizlendi" 
                value={debugInfo.cleanupValidation.timersCleared ? '✓' : '✗'} 
                status={debugInfo.cleanupValidation.timersCleared ? 'completed' : 'error'}
              />
              <DebugRow 
                label="Worker Sonlandırıldı" 
                value={debugInfo.cleanupValidation.workerTerminated ? '✓' : '-'} 
                status={debugInfo.cleanupValidation.workerTerminated ? 'completed' : 'idle'}
              />
              {debugInfo.cleanupDuration !== null && (
                <DebugRow 
                  label="Cleanup Süresi" 
                  value={`${debugInfo.cleanupDuration}ms`} 
                />
              )}
              {debugInfo.cleanupValidation.errorDuringCleanup && (
                <DebugRow 
                  label="Cleanup Hatası" 
                  value={debugInfo.cleanupValidation.errorDuringCleanup} 
                  status="warning"
                />
              )}
            </DebugSection>
          )}

          {/* Execution Info */}
          <DebugSection title="Çalıştırma Bilgileri">
            <DebugRow 
              label="ffmpeg.exec Başlama" 
              value={debugInfo.ffmpegExecStartTime ? new Date(debugInfo.ffmpegExecStartTime).toLocaleTimeString('tr-TR') : null} 
            />
            <DebugRow label="Son Progress Değeri" value={debugInfo.lastProgressValue !== null ? `${debugInfo.lastProgressValue}%` : null} />
            <DebugRow label="Geçen Süre" value={formatTime(debugInfo.elapsedTime)} />
          </DebugSection>

          {/* Encoding Stats */}
          {(debugInfo.encodedTime !== null || debugInfo.encodingSpeed !== null) && (
            <DebugSection title="Encoding İstatistikleri">
              <DebugRow 
                label="Toplam Video Süresi" 
                value={formatEncodedTime(debugInfo.totalDuration ?? null)} 
              />
              <DebugRow 
                label="İşlenen Video Süresi" 
                value={formatEncodedTime(debugInfo.encodedTime ?? null)} 
              />
              <DebugRow 
                label="Gerçek Progress (%)" 
                value={debugInfo.encodedTime !== null && debugInfo.totalDuration !== null && debugInfo.totalDuration > 0 
                  ? `${Math.min(99, Math.floor((debugInfo.encodedTime / debugInfo.totalDuration) * 100))}%` 
                  : null} 
              />
              <DebugRow 
                label="Metadata Source" 
                value={debugInfo.metadataSource === 'html5' ? 'HTML5 Video' : debugInfo.metadataSource === 'ffmpeg_fallback' ? 'FFmpeg Fallback' : null} 
              />
              <DebugRow 
                label="Encoding Hızı" 
                value={debugInfo.encodingSpeed !== null ? `${debugInfo.encodingSpeed.toFixed(3)}x` : null} 
              />
              <DebugRow 
                label="FPS" 
                value={debugInfo.encodingFps !== null ? `${debugInfo.encodingFps.toFixed(1)}` : null} 
              />
              <DebugRow 
                label="İşlenen Frame" 
                value={debugInfo.encodedFrame !== null ? `${debugInfo.encodedFrame}` : null} 
              />
              {debugInfo.duplicatedFrames !== null && (
                <DebugRow 
                  label="Duplicate Frame" 
                  value={`${debugInfo.duplicatedFrames}`} 
                  status={debugInfo.duplicatedFrames > 100 ? 'warning' : undefined}
                />
              )}
            </DebugSection>
          )}

          {/* Compression Stats */}
          {debugInfo.outputSize !== null && (
            <DebugSection title="Sıkıştırma Bilgileri">
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Giriş (Input)</span>
                  <span className="text-slate-700 font-mono">{formatBytes(debugInfo.inputSize)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Çıkış (Output)</span>
                  <span className="text-slate-700 font-mono">{formatBytes(debugInfo.outputSize)}</span>
                </div>
                <div className="flex justify-between items-center bg-emerald-50 -mx-2 px-2 py-1 rounded-lg">
                  <span className="text-emerald-700 font-medium">Sıkıştırma</span>
                  <span className="text-emerald-700 font-bold font-mono">
                    {debugInfo.compressionRatio !== null ? `${debugInfo.compressionRatio}%` : '-'}
                  </span>
                </div>
              </div>
            </DebugSection>
          )}

          {/* Bitrate Stats */}
          {debugInfo.totalBitrate !== null && (
            <DebugSection title="Bitrate Bilgileri">
              <DebugRow 
                label="Video Bitrate" 
                value={debugInfo.videoBitrate !== null ? `${debugInfo.videoBitrate.toFixed(0)} kbps` : null} 
              />
              <DebugRow 
                label="Ses Bitrate" 
                value={debugInfo.audioBitrate !== null ? `${debugInfo.audioBitrate} kbps` : null} 
              />
              <DebugRow 
                label="Toplam Bitrate" 
                value={debugInfo.totalBitrate !== null ? `${debugInfo.totalBitrate.toFixed(0)} kbps` : null} 
              />
            </DebugSection>
          )}

          {/* Error Info */}
          {(debugInfo.errorCode || debugInfo.errorMessage) && (
            <DebugSection title="Hata Bilgileri">
              <div className="space-y-2">
                <DebugRow label="Hata Kodu" value={debugInfo.errorCode} status="error" />
                <div>
                  <span className="text-slate-500 block mb-1">Hata Mesajı:</span>
                  <div className="bg-red-50 text-red-700 p-2 rounded-lg">
                    {debugInfo.errorMessage}
                  </div>
                </div>
                {debugInfo.errorStack && (
                  <div>
                    <span className="text-slate-500 block mb-1">Stack Trace:</span>
                    <pre className="bg-red-50 text-red-700 p-2 rounded-lg overflow-x-auto whitespace-pre-wrap break-all">
                      {debugInfo.errorStack}
                    </pre>
                  </div>
                )}
              </div>
            </DebugSection>
          )}

          {/* Last FFmpeg Logs */}
          {debugInfo.lastLogLines.length > 0 && (
            <DebugSection title="Son FFmpeg Logları">
              <div className="bg-slate-900 text-emerald-400 p-2 rounded-lg font-mono text-xs max-h-32 overflow-y-auto">
                {debugInfo.lastLogLines.map((line, i) => (
                  <div key={i} className="break-all">{line}</div>
                ))}
              </div>
            </DebugSection>
          )}

          {/* All Logs Toggle */}
          <div className="pt-3 border-t border-slate-100">
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="flex items-center gap-1.5 text-xs text-[#376BFC] hover:text-[#2858E0] transition-colors"
            >
              {showLogs ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              Tüm Logları {showLogs ? 'Gizle' : 'Göster'} ({debugInfo.logs.length})
            </button>

            {showLogs && (
              <div className="mt-2 bg-slate-900 text-emerald-400 p-2 rounded-lg font-mono text-xs max-h-48 overflow-y-auto">
                {debugInfo.logs.map((log, i) => (
                  <LogEntry key={i} entry={log} />
                ))}
                {debugInfo.logs.length === 0 && (
                  <div className="text-slate-500 text-center py-4">Henüz log yok</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
