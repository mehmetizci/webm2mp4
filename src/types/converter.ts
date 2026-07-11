export interface VideoMetadata {
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface ConversionProgress {
  percent: number;
  time: number;
  stage: ConversionStage;
}

export type ConversionStage =
  | 'idle'
  | 'loading'
  | 'reading'
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

export type ConversionState =
  | { status: 'idle' }
  | { status: 'file-selected'; file: File; metadata: VideoMetadata }
  | { status: 'converting'; progress: ConversionProgress }
  | { status: 'complete'; result: ConversionResult }
  | { status: 'error'; error: ConversionError };

export const QUALITY_PRESETS: Record<QualityPreset, { crf: number; label: string }> = {
  high: { crf: 18, label: 'Yüksek kalite' },
  balanced: { crf: 23, label: 'Dengeli' },
  small: { crf: 28, label: 'Küçük dosya' },
};

export const STAGE_LABELS: Record<ConversionStage, string> = {
  idle: '',
  loading: 'Dönüştürücü hazırlanıyor',
  reading: 'Video okunuyor',
  converting: 'Video dönüştürülüyor',
  finalizing: 'MP4 dosyası hazırlanıyor',
  complete: 'İşlem tamamlandı',
  error: 'Hata oluştu',
};
