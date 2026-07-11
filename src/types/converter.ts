export interface VideoMetadata {
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean | null;
  frameRate?: number;
}

export interface MediaInfo {
  fileName: string;
  fileSize: number;
  videoCodec: string | null;
  resolution: string | null;
  frameRate: number | null;
  bitrate: number | null;
  duration: number | null;
  hasAudio: boolean;
  audioCodec: string | null;
  audioBitrate: number | null;
  audioSampleRate: number | null;
}

export interface ConversionProgress {
  percent: number;
  time: number;
  stage: ConversionStage;
  hasProgress?: boolean; // Whether actual progress events have been received
  encodedTime?: number | null; // Video time encoded so far (seconds)
  encodingSpeed?: number | null; // Current encoding speed (e.g., 0.125x)
}

export type ConversionStage =
  | 'idle'
  | 'loading'
  | 'reading'
  | 'analyzing'
  | 'converting'
  | 'finalizing'
  | 'complete'
  | 'error';

export type QualityPreset = 'high' | 'balanced' | 'small';

export interface ConversionSettings {
  quality: QualityPreset;
}

export interface ConversionResult {
  blob: Blob;
  fileName: string;
  fileSize: number;
  duration: number;
}

export interface ConversionError {
  code: string;
  message: string;
  technical?: string;
}

export const QUALITY_PRESETS: Record<QualityPreset, { crf: number; label: string }> = {
  high: { crf: 18, label: 'Yüksek kalite' },
  balanced: { crf: 23, label: 'Dengeli' },
  small: { crf: 28, label: 'Küçük dosya' },
};

export const STAGE_LABELS: Record<ConversionStage, string> = {
  idle: '',
  loading: 'Dönüştürücü hazırlanıyor',
  reading: 'Video dosyası okunuyor',
  analyzing: 'Video analiz ediliyor',
  converting: 'Video H.264 codec\'e dönüştürülüyor',
  finalizing: 'MP4 dosyası paketleniyor',
  complete: 'İşlem tamamlandı',
  error: 'Hata oluştu',
};
