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
        border-2 border-dashed rounded-[10px] cursor-pointer
        transition-all duration-200
        ${isDragging 
          ? 'border-[#376BFC] bg-[#376BFC]/5' 
          : 'border-[#D1D5DB] bg-[#FAFAFA] hover:border-[#376BFC]/50 hover:bg-[#376BFC]/5'
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
      
      <div className="flex flex-col items-center gap-4 px-4 text-center">
        <div className={`
          w-16 h-16 rounded-full flex items-center justify-center
          ${isDragging ? 'bg-[#376BFC]/10' : 'bg-[#F3F4F6]'}
        `}>
          <UploadCloud 
            className={`w-8 h-8 ${isDragging ? 'text-[#376BFC]' : 'text-[#6B7280]'}`} 
          />
        </div>
        
        <div className="space-y-1">
          <p className="text-[#1F2937] font-medium text-base sm:text-lg">
            WebM dosyanızı buraya sürükleyin
          </p>
          <p className="text-[#6B7280] text-sm">
            veya dosya seçmek için dokunun
          </p>
        </div>
        
        <div className="space-y-1 mt-2">
          <p className="text-[#9CA3AF] text-xs sm:text-sm">
            Yalnızca .webm dosyaları desteklenir
          </p>
          <p className="text-[#9CA3AF] text-xs">
            Maksimum dosya boyutu cihaz kapasitesine bağlıdır
          </p>
        </div>
      </div>

      {error && (
        <div className="absolute bottom-4 left-4 right-4">
          <p className="text-red-500 text-sm text-center bg-red-50 px-4 py-2 rounded-lg">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
