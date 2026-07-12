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
  totalDuration?: number | null; // Total video duration in seconds
}

export type ConversionStage =
  | 'idle'
  | 'loading'
  | 'reading'
  | 'analyzing'
  | 'initializing'
  | 'converting'
  | 'encoding'
  | 'finalizing'
  | 'complete'
  | 'error';

export type QualityPreset = 'standard' | 'high' | 'small';

export interface ConversionSettings {
  quality: QualityPreset;
}

export interface ConversionResult {
  blob: Blob;
  fileName: string;
  fileSize: number;
  // Video duration (actual video length being converted)
  videoDuration: number; // seconds
  // Conversion duration (wall clock time for the conversion process)
  conversionTime: number; // seconds
  // Compression stats
  inputSize: number;
  outputSize: number;
  compressionRatio: number; // percentage (e.g., 55 means 55% reduction)
  videoBitrate?: number; // kbps
  audioBitrate?: number; // kbps
  totalBitrate?: number; // kbps
  // Encoding stats
  encodeTime?: number; // seconds (FFmpeg execution time)
  averageSpeed?: number; // e.g., 0.44x
  // Audio info
  hasAudio: boolean;
  // Engine info
  engine: 'webcodecs' | 'ffmpeg-wasm';
}

export interface ConversionError {
  code: string;
  message: string;
  technical?: string;
}

export const QUALITY_PRESETS: Record<QualityPreset, { crf: number; maxrate: number; label: string; description: string }> = {
  small: { 
    crf: 30, 
    maxrate: 600, 
    label: 'Küçük Dosya', 
    description: 'En küçük dosya boyutu - ~600 kbps, harita yazıları okunabilir' 
  },
  standard: { 
    crf: 26, 
    maxrate: 1000, 
    label: 'Standart', 
    description: 'Dengeli kalite ve dosya boyutu - ~1 Mbps' 
  },
  high: { 
    crf: 20, 
    maxrate: 1800, 
    label: 'Yüksek Kalite', 
    description: 'En iyi kalite - ~1.8 Mbps' 
  },
};

export const STAGE_LABELS: Record<ConversionStage, string> = {
  idle: '',
  loading: 'Dönüştürücü hazırlanıyor',
  reading: 'Dosya analiz ediliyor',
  analyzing: 'Video çözümleniyor',
  initializing: 'WebCodecs hazırlanıyor',
  converting: 'Video dönüştürülüyor',
  encoding: 'Video dönüştürülüyor',
  finalizing: 'MP4 oluşturuluyor',
  complete: 'İşlem tamamlandı',
  error: 'Hata oluştu',
};
