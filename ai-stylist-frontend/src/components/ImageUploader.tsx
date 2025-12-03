'use client';

import { useCallback, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { UploadCloud } from 'lucide-react';

type ImageUploaderProps = {
  onFileChange: (file: File | null) => void;
  onPreviewChange?: (previewUrl: string | null) => void;
};

export function ImageUploader({ onFileChange, onPreviewChange }: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback(
    (files?: FileList | null) => {
      const file = files?.[0];
      if (!file) {
        setPreview(null);
        onPreviewChange?.(null);
        onFileChange(null);
        return;
      }
      const url = URL.createObjectURL(file);
      setPreview(url);
      onPreviewChange?.(url);
      onFileChange(file);
    },
    [onFileChange, onPreviewChange],
  );

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => {
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <motion.div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      className="group relative flex h-80 w-full cursor-pointer items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur transition hover:border-white/30"
      animate={{ borderColor: isDragging ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.2)' }}
    >
      {preview ? (
        <>
          <img src={preview} alt="Preview" className="h-full w-full rounded-2xl object-cover" />
          <div className="absolute bottom-4 right-4 rounded-full bg-black/60 px-4 py-1 text-xs uppercase tracking-widest text-white">
            Change Photo
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center space-y-4 text-white/70">
          <div className="rounded-full bg-white/10 p-4">
            <UploadCloud className="h-8 w-8 text-white" />
          </div>
          <div>
            <p className="text-lg font-semibold text-white">Drag & Drop your photo</p>
            <p className="text-sm text-white/60">or click to browse files</p>
          </div>
        </div>
      )}
      <input
        type="file"
        accept="image/*"
        ref={inputRef}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </motion.div>
  );
}




