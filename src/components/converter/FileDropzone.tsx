'use client';

import { useCallback, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { isValidWebMFile } from '@/lib/file-utils';

interface FileDropzoneProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

export function FileDropzone({ onFileSelect, disabled }: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      setIsDragging(true);
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (disabled) return;

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (isValidWebMFile(file)) {
        setError(null);
        onFileSelect(file);
      } else {
        setError('Lütfen geçerli bir WebM video dosyası seçin.');
      }
    }
  }, [disabled, onFileSelect]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (isValidWebMFile(file)) {
        setError(null);
        onFileSelect(file);
      } else {
        setError('Lütfen geçerli bir WebM video dosyası seçin.');
      }
    }
    e.target.value = '';
  }, [onFileSelect]);

  return (
    <div
      className={`
        relative flex flex-col items-center justify-center
        w-full min-h-[280px] sm:min-h-[320px]
        border-2 border-dashed rounded-2xl cursor-pointer
        transition-all duration-200
        ${isDragging 
          ? 'border-[#376BFC] bg-blue-50/50' 
          : 'border-slate-200 bg-slate-50/50 hover:border-[#376BFC]/50 hover:bg-blue-50/30'
        }
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        type="file"
        accept="video/webm,.webm"
        onChange={handleFileInput}
        disabled={disabled}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
      />
      
      <div className="flex flex-col items-center gap-5 px-4 text-center">
        <div className={`
          w-16 h-16 rounded-2xl flex items-center justify-center
          transition-colors duration-200
          ${isDragging ? 'bg-[#376BFC]/10' : 'bg-white shadow-sm'}
        `}>
          <UploadCloud 
            className={`w-8 h-8 transition-colors duration-200 ${isDragging ? 'text-[#376BFC]' : 'text-slate-400'}`} 
          />
        </div>
        
        <div className="space-y-1.5">
          <p className="text-slate-800 font-medium text-lg">
            WebM dosyanızı buraya sürükleyin
          </p>
          <p className="text-slate-500 text-sm">
            veya dosya seçmek için dokunun
          </p>
        </div>
        
        <div className="space-y-1">
          <p className="text-slate-400 text-sm">
            Yalnızca .webm dosyaları desteklenir
          </p>
          <p className="text-slate-400 text-xs">
            Maksimum dosya boyutu cihaz kapasitesine bağlıdır
          </p>
        </div>
      </div>

      {error && (
        <div className="absolute bottom-5 left-5 right-5">
          <p className="text-red-500 text-sm text-center bg-red-50 px-4 py-2.5 rounded-xl border border-red-100">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
