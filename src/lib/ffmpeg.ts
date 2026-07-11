import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { QualityPreset } from '@/types/converter';

let ffmpegInstance: FFmpeg | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance) {
    return ffmpegInstance;
  }

  const ffmpeg = new FFmpeg();

  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

export async function convertWebMToMP4(
  ffmpeg: FFmpeg,
  inputData: Uint8Array,
  inputFileName: string,
  outputFileName: string,
  quality: QualityPreset,
  onProgress?: (progress: number) => void
): Promise<Uint8Array> {
  const crfMap = {
    high: 18,
    balanced: 23,
    small: 28,
  };

  const crf = crfMap[quality];

  ffmpeg.on('progress', ({ progress }) => {
    if (onProgress) {
      onProgress(Math.min(progress * 100, 99));
    }
  });

  await ffmpeg.writeFile(inputFileName, inputData);

  const hasAudio = await checkHasAudio(ffmpeg, inputFileName);

  if (hasAudio) {
    await ffmpeg.exec([
      '-i', inputFileName,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', crf.toString(),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      outputFileName,
    ]);
  } else {
    await ffmpeg.exec([
      '-i', inputFileName,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', crf.toString(),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      outputFileName,
    ]);
  }

  if (onProgress) {
    onProgress(100);
  }

  const data = await ffmpeg.readFile(outputFileName);

  await ffmpeg.deleteFile(inputFileName);
  await ffmpeg.deleteFile(outputFileName);

  return data as Uint8Array;
}

async function checkHasAudio(ffmpeg: FFmpeg, inputFileName: string): Promise<boolean> {
  try {
    let hasAudio = false;
    
    ffmpeg.on('log', ({ message }) => {
      if (message.includes('Audio:')) {
        hasAudio = true;
      }
    });

    await ffmpeg.exec(['-i', inputFileName, '-f', 'null', '-']);

    return hasAudio;
  } catch {
    return false;
  }
}

export async function cleanupFFmpeg(ffmpeg: FFmpeg): Promise<void> {
  try {
    const files = ['input.webm', 'output.mp4'];
    for (const file of files) {
      try {
        await ffmpeg.deleteFile(file);
      } catch {
        // File might not exist, ignore
      }
    }
  } catch (error) {
    console.error('FFmpeg cleanup error:', error);
  }
}
