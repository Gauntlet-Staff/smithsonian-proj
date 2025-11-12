export interface ImageUpload {
  id: string;
  userId: string;
  imageUrl: string;
  thumbnailUrl?: string;
  extractedText: string;
  fileName: string;
  fileSize: number;
  uploadedAt: Date;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  processedAt?: Date;
}

export interface UploadProgress {
  fileName: string;
  progress: number;
  status: 'uploading' | 'uploaded' | 'processing' | 'completed' | 'failed';
  error?: string;
}

