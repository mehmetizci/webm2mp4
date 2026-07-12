// Quality Configuration for WebCodecs/Mediabunny encoder
// Maps quality presets to actual encoder settings based on resolution

import type { QualityPreset } from '@/types/converter';

// Hardware acceleration mode - separate from quality presets
export type HardwareMode = 'no-preference' | 'prefer-hardware' | 'prefer-software';

// Default hardware mode per Mediabunny documentation
export const DEFAULT_HARDWARE_MODE: HardwareMode = 'no-preference';

export interface EncoderConfig {
  bitrate: number;
  framerate: number;
  codec: 'avc';
  hardwareAcceleration: HardwareMode;
  keyFrameInterval: number;
}

export interface QualityConfig {
  videoBitrate: number;
  audioBitrate: number;
  encoder: EncoderConfig;
}

// Resolution-based bitrate tiers (in bits per second)
// These values are optimized for map/text readability while minimizing file size
const BITRATE_TIERS = {
  // For vertical videos (width < height) - common mobile aspect ratios
  vertical: {
    // 720p vertical (720x1280)
    720: {
      small: 600_000,    // 600 kbps - minimum for map text readability
      standard: 1_000_000, // 1 Mbps
      high: 1_800_000,  // 1.8 Mbps
    },
    // 1080p vertical (1080x1920)
    1080: {
      small: 1_000_000,    // 1 Mbps
      standard: 2_000_000, // 2 Mbps
      high: 3_500_000,  // 3.5 Mbps
    },
    // 480p vertical (480x854)
    480: {
      small: 400_000,    // 400 kbps
      standard: 600_000, // 600 kbps
      high: 800_000,    // 800 kbps
    },
  },
  // For horizontal/landscape videos (width > height)
  horizontal: {
    // 720p horizontal (1280x720)
    720: {
      small: 600_000,    // 600 kbps
      standard: 1_200_000, // 1.2 Mbps
      high: 2_000_000,  // 2 Mbps
    },
    // 1080p horizontal (1920x1080)
    1080: {
      small: 1_000_000,   // 1 Mbps
      standard: 2_000_000, // 2 Mbps
      high: 3_500_000,  // 3.5 Mbps
    },
    // 480p horizontal (854x480)
    480: {
      small: 400_000,    // 400 kbps
      standard: 600_000, // 600 kbps
      high: 1_000_000,  // 1 Mbps
    },
  },
};

// Audio bitrate (constant for all presets)
const AUDIO_BITRATE = 128_000; // 128 kbps AAC

function getResolutionTier(width: number, height: number): '480' | '720' | '1080' {
  // Use the shorter dimension to determine tier (works for both orientations)
  const minDimension = Math.min(width, height);
  
  if (minDimension >= 1080) return '1080';
  if (minDimension >= 720) return '720';
  return '480';
}

function isVertical(width: number, height: number): boolean {
  return height > width;
}

/**
 * Get the encoder configuration based on quality preset and video dimensions
 * Note: hardwareAcceleration is now separate - use getEncoderConfigWithHardwareMode()
 * if you need to override the default hardware mode
 */
export function getEncoderConfig(
  width: number,
  height: number,
  fps: number = 30,
  quality: QualityPreset = 'standard',
  hardwareMode: HardwareMode = DEFAULT_HARDWARE_MODE
): QualityConfig {
  const resolutionTier = getResolutionTier(width, height);
  const orientation = isVertical(width, height) ? 'vertical' : 'horizontal';
  
  // Get bitrate for this resolution and quality
  const bitrate = BITRATE_TIERS[orientation][resolutionTier][quality];
  
  // Audio bitrate is constant across presets
  const audioBitrate = AUDIO_BITRATE;
  
  return {
    videoBitrate: bitrate,
    audioBitrate,
    encoder: {
      bitrate,
      framerate: fps,
      codec: 'avc',
      hardwareAcceleration: hardwareMode,
      keyFrameInterval: 2, // Keyframe every 2 seconds
    },
  };
}

/**
 * Get encoder configuration with explicit hardware mode
 * Use this when you need to test different hardware acceleration modes
 */
export function getEncoderConfigWithHardwareMode(
  width: number,
  height: number,
  fps: number,
  quality: QualityPreset,
  hardwareMode: HardwareMode
): QualityConfig {
  return getEncoderConfig(width, height, fps, quality, hardwareMode);
}

/**
 * Get just the video bitrate based on quality and dimensions
 */
export function getTargetBitrate(
  width: number,
  height: number,
  quality: QualityPreset = 'standard'
): number {
  const config = getEncoderConfig(width, height, 30, quality);
  return config.videoBitrate;
}

/**
 * Format bitrate for display (e.g., 2000000 -> "2 Mbps")
 */
export function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  }
  return `${(bps / 1_000).toFixed(0)} kbps`;
}

/**
 * Get a human-readable description of the quality preset
 */
export function getQualityDescription(
  width: number,
  height: number,
  quality: QualityPreset
): string {
  const config = getEncoderConfig(width, height, 30, quality);
  const resolutionTier = getResolutionTier(width, height);
  
  const qualityLabels: Record<QualityPreset, string> = {
    small: 'Küçük Dosya',
    standard: 'Standart',
    high: 'Yüksek Kalite',
  };
  
  return `${qualityLabels[quality]} • ${resolutionTier}p • ${formatBitrate(config.videoBitrate)}`;
}
