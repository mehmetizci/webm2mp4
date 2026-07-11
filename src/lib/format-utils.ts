export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  
  if (mins > 0) {
    return `${mins} dk ${secs} sn`;
  }
  return `${secs} sn`;
}

export function formatPercentage(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatResolution(width: number, height: number): string {
  return `${width}×${height}`;
}

export function getResolutionLabel(width: number, height: number): string {
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return 'Full HD';
  if (height >= 720) return 'HD';
  if (height >= 480) return 'SD';
  return 'Düşük';
}
