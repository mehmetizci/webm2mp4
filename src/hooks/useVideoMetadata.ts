'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
    if (videoElementRef.current) {
      videoElementRef.current.src = '';
      videoElementRef.current = null;
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
  const [state, setState] = useState<UseVideoMetadataResult>({
    metadata: null,
    previewUrl: null,
    error: null,
    isLoading: false,
  });
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file) {
      // Cleanup
      if (previewUrlRef.current) {
        revokeBlobUrl(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.src = '';
        videoRef.current = null;
      }
      setState({
        metadata: null,
        previewUrl: null,
        error: null,
        isLoading: false,
      });
      return;
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    const video = document.createElement('video');
    videoRef.current = video;
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const url = createBlobUrl(file);
    previewUrlRef.current = url;
    video.src = url;

    const cleanup = () => {
      if (videoRef.current) {
        videoRef.current.src = '';
        videoRef.current = null;
      }
    };

    video.onloadedmetadata = () => {
      const metadata: VideoMetadata = {
        name: file.name,
        size: file.size,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        hasAudio: false,
      };
      
      setState({
        metadata,
        previewUrl: url,
        error: null,
        isLoading: false,
      });
      cleanup();
    };

    video.onerror = () => {
      setState({
        metadata: null,
        previewUrl: null,
        error: 'Video dosyası okunamadı veya bozuk olabilir.',
        isLoading: false,
      });
      cleanup();
    };

    return cleanup;
  }, [file]);

  return state;
}
