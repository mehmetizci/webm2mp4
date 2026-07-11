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
  const [state, setState] = useState<UseVideoMetadataResult>({
    metadata: null,
    previewUrl: null,
    error: null,
    isLoading: false,
  });
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const reset = useCallback(() => {
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
  }, []);

  const loadMetadata = useCallback((file: File) => {
    reset();
    setState(prev => ({ ...prev, isLoading: true }));

    const video = document.createElement('video');
    videoRef.current = video;
    video.preload = 'metadata';
    video.muted = true;

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
      setState({
        metadata: {
          name: file.name,
          size: file.size,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          hasAudio: null,
        },
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
  }, [reset]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        revokeBlobUrl(previewUrlRef.current);
      }
      if (videoRef.current) {
        videoRef.current.src = '';
      }
    };
  }, []);

  return {
    ...state,
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
    const cleanup = () => {
      if (previewUrlRef.current) {
        revokeBlobUrl(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.src = '';
        videoRef.current = null;
      }
    };

    if (!file) {
      cleanup();
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

    const onMetadata = () => {
      const metadata: VideoMetadata = {
        name: file.name,
        size: file.size,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        hasAudio: null,
      };
      
      setState({
        metadata,
        previewUrl: url,
        error: null,
        isLoading: false,
      });
      cleanup();
    };

    const onError = () => {
      setState({
        metadata: null,
        previewUrl: null,
        error: 'Video dosyası okunamadı veya bozuk olabilir.',
        isLoading: false,
      });
      cleanup();
    };

    video.onloadedmetadata = onMetadata;
    video.onerror = onError;

    return () => {
      cleanup();
    };
  }, [file]);

  return state;
}
