'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { VideoMetadata } from '@/types/converter';
import { createBlobUrl, revokeBlobUrl } from '@/lib/file-utils';

interface UseVideoMetadataResult {
  metadata: VideoMetadata | null;
  previewUrl: string | null;
  error: string | null;
  isLoading: boolean;
}

export function useVideoMetadata(): UseVideoMetadataResult & {
  loadMetadata: (file: File) => void;
  reset: () => void;
} {
  const metadataRef = useRef<VideoMetadata | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const errorRef = useRef<string | null>(null);
  const isLoadingRef = useRef<boolean>(false);

  const reset = useCallback(() => {
    if (previewUrlRef.current) {
      revokeBlobUrl(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    metadataRef.current = null;
    errorRef.current = null;
    isLoadingRef.current = false;
  }, []);

  const loadMetadata = useCallback((file: File) => {
    reset();
    isLoadingRef.current = true;

    const video = document.createElement('video');
    videoElementRef.current = video;
    video.preload = 'metadata';
    video.muted = true;

    const url = createBlobUrl(file);
    previewUrlRef.current = url;
    video.src = url;

    video.onloadedmetadata = () => {
      metadataRef.current = {
        name: file.name,
        size: file.size,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        hasAudio: false,
      };
      isLoadingRef.current = false;
    };

    video.onerror = () => {
      errorRef.current = 'Video dosyası okunamadı veya bozuk olabilir.';
      isLoadingRef.current = false;
    };
  }, [reset]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        revokeBlobUrl(previewUrlRef.current);
      }
      if (videoElementRef.current) {
        videoElementRef.current.src = '';
      }
    };
  }, []);

  return {
    metadata: metadataRef.current,
    previewUrl: previewUrlRef.current,
    error: errorRef.current,
    isLoading: isLoadingRef.current,
    loadMetadata,
    reset,
  };
}

export function useVideoMetadataState(
  file: File | null
): UseVideoMetadataResult {
  const metadataRef = useRef<VideoMetadata | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const errorRef = useRef<string | null>(null);
  const isLoadingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!file) {
      if (previewUrlRef.current) {
        revokeBlobUrl(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      metadataRef.current = null;
      errorRef.current = null;
      isLoadingRef.current = false;
      return;
    }

    isLoadingRef.current = true;

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const url = createBlobUrl(file);
    previewUrlRef.current = url;
    video.src = url;

    const cleanup = () => {
      video.src = '';
    };

    video.onloadedmetadata = () => {
      metadataRef.current = {
        name: file.name,
        size: file.size,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        hasAudio: false,
      };
      isLoadingRef.current = false;
      cleanup();
    };

    video.onerror = () => {
      errorRef.current = 'Video dosyası okunamadı veya bozuk olabilir.';
      isLoadingRef.current = false;
      cleanup();
    };

    return cleanup;
  }, [file]);

  return {
    metadata: metadataRef.current,
    previewUrl: previewUrlRef.current,
    error: errorRef.current,
    isLoading: isLoadingRef.current,
  };
}
