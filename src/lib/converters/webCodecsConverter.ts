// WebCodecs Video Converter
// NOTE: WebCodecs conversion is not yet fully implemented
// This module provides the support check functionality

import type {
  VideoConverter,
  ConvertOptions,
  ConversionResult,
  ConverterSupport,
  ConversionProgress,
} from './types';
import { checkWebCodecsSupport } from './webCodecsSupport';

export class WebCodecsConverter implements VideoConverter {
  async checkSupport(): Promise<ConverterSupport> {
    const support = await checkWebCodecsSupport();
    return {
      supported: support.supported,
      reason: support.reason,
      details: support.details,
    };
  }

  async convert(options: ConvertOptions): Promise<ConversionResult> {
    // WebCodecs conversion is not yet implemented
    // This will be implemented in a future update
    throw new Error('WebCodecs conversion is not yet implemented');
  }

  async cleanup(): Promise<void> {
    // Cleanup will be implemented when WebCodecs conversion is ready
  }
}

// Singleton instance
let webCodecsInstance: WebCodecsConverter | null = null;

export function getWebCodecsConverter(): WebCodecsConverter {
  if (!webCodecsInstance) {
    webCodecsInstance = new WebCodecsConverter();
  }
  return webCodecsInstance;
}
