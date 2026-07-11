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
  pixelFormat: string | null;
  frameRate: number | null;
  bitrate: number | null;
  duration: number | null;
  hasAudio: boolean;
  audioCodec: string | null;
  audioBitrate: number | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
}

export interface EncoderInfo {
  h264: boolean;
  vp8: boolean;
  vp9: boolean;
  aac: boolean;
  mp3: boolean;
}

export interface ConversionCapabilities {
  encoders: EncoderInfo;
  videoCodec: 'libx264' | 'libvpx' | 'libvpx-vp9';
  audioCodec: 'aac' | 'mp3';
}

export interface FileInfo {
  file: File;
  metadata: VideoMetadata | null;
  mediaInfo: MediaInfo | null;
  previewUrl: string | null;
  isAnalyzing: boolean;
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
