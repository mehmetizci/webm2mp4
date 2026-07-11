export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function getOutputFileName(inputFileName: string): string {
  const baseName = inputFileName.replace(/\.webm$/i, '');
  return `${baseName}.mp4`;
}

export function isValidWebMFile(file: File): boolean {
  const fileName = file.name.toLowerCase().trim();
  const hasWebmExtension = fileName.endsWith('.webm');

  const supportedMimeTypes = [
    'video/webm',
    'video/x-webm',
    'application/webm',
    'application/octet-stream',
  ];

  const hasSupportedMimeType =
    file.type === '' || supportedMimeTypes.includes(file.type.toLowerCase());

  return hasWebmExtension && hasSupportedMimeType;
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('Dosya okunamadı'));
    reader.readAsArrayBuffer(file);
  });
}

export function createBlobUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function revokeBlobUrl(url: string): void {
  if (url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = createBlobUrl(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  revokeBlobUrl(url);
}
