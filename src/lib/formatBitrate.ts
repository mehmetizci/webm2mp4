/**
 * Format bitrate in bits per second to human-readable format
 * @param bps - Bitrate in bits per second
 * @returns Formatted string like "2.5 Mbps" or "2500 kbps"
 */
export function formatBitrate(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps < 0) {
    return 'Hesaplanamadı';
  }

  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  }

  return `${Math.round(bps / 1000)} kbps`;
}

/**
 * Format bitrate in kbps (for display where unit is already indicated)
 * @param kbps - Bitrate in kilobits per second
 * @returns Formatted string like "2500 kbps"
 */
export function formatBitrateKbps(kbps: number | null | undefined): string {
  if (kbps == null || !Number.isFinite(kbps) || kbps < 0) {
    return 'Hesaplanamadı';
  }

  return `${Math.round(kbps)} kbps`;
}
