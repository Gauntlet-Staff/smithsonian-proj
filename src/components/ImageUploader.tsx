import { useState, useRef } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { storage, db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import type { UploadProgress } from '../types/image';
import '../styles/ImageUploader.css';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];

export default function ImageUploader({ onUploadComplete }: { onUploadComplete: () => void }) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState<Map<string, UploadProgress>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { currentUser } = useAuth();

  const validateFile = (file: File): string | null => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return `${file.name}: Invalid file type. Please upload JPEG, PNG, or HEIC images.`;
    }
    if (file.size > MAX_FILE_SIZE) {
      return `${file.name}: File size exceeds 10MB limit.`;
    }
    return null;
  };

  const uploadImage = async (file: File) => {
    if (!currentUser) return;

    const validationError = validateFile(file);
    if (validationError) {
      setUploads(prev => new Map(prev).set(file.name, {
        fileName: file.name,
        progress: 0,
        status: 'failed',
        error: validationError,
      }));
      return;
    }

    // Initialize upload progress
    setUploads(prev => new Map(prev).set(file.name, {
      fileName: file.name,
      progress: 0,
      status: 'uploading',
    }));

    try {
      // Upload to Firebase Storage
      const storageRef = ref(storage, `images/${currentUser.uid}/${Date.now()}_${file.name}`);
      const uploadTask = uploadBytesResumable(storageRef, file);

      uploadTask.on(
        'state_changed',
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          setUploads(prev => {
            const newMap = new Map(prev);
            const current = newMap.get(file.name);
            if (current) {
              newMap.set(file.name, { ...current, progress });
            }
            return newMap;
          });
        },
        (error) => {
          console.error('Upload error:', error);
          setUploads(prev => new Map(prev).set(file.name, {
            fileName: file.name,
            progress: 0,
            status: 'failed',
            error: 'Upload failed. Please try again.',
          }));
        },
        async () => {
          try {
            // Get download URL
            const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);

            // Update status to uploaded (waiting for Cloud Function processing)
            setUploads(prev => {
              const newMap = new Map(prev);
              const current = newMap.get(file.name);
              if (current) {
                newMap.set(file.name, { ...current, progress: 100, status: 'uploaded' });
              }
              return newMap;
            });

            // Create Firestore document with status 'pending'
            // The Cloud Function will automatically trigger and process it
            await addDoc(collection(db, 'images'), {
              userId: currentUser.uid,
              imageUrl: downloadURL,
              extractedText: '', // Will be filled by Cloud Function
              fileName: file.name,
              fileSize: file.size,
              uploadedAt: serverTimestamp(),
              status: 'pending', // Cloud Function will process this
            });

            // Mark as completed (upload complete, processing will happen in background)
            setUploads(prev => new Map(prev).set(file.name, {
              fileName: file.name,
              progress: 100,
              status: 'completed',
            }));

            // Notify parent component
            onUploadComplete();

            // Remove from list after 2 seconds
            setTimeout(() => {
              setUploads(prev => {
                const newMap = new Map(prev);
                newMap.delete(file.name);
                return newMap;
              });
            }, 2000);

          } catch (error) {
            console.error('Processing error:', error);
            setUploads(prev => new Map(prev).set(file.name, {
              fileName: file.name,
              progress: 0,
              status: 'failed',
              error: 'Failed to save image metadata. Please try again.',
            }));
          }
        }
      );
    } catch (error) {
      console.error('Error:', error);
      setUploads(prev => new Map(prev).set(file.name, {
        fileName: file.name,
        progress: 0,
        status: 'failed',
        error: 'An unexpected error occurred.',
      }));
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    
    Array.from(files).forEach(file => {
      uploadImage(file);
    });
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
    // Reset input so same file can be uploaded again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="image-uploader">
      <div
        className={`upload-zone ${isDragging ? 'dragging' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/heic,image/heif"
          onChange={handleFileInput}
          style={{ display: 'none' }}
        />
        
        <div className="upload-icon">📸</div>
        <h3>Upload Images</h3>
        <p>Drag and drop images here, or click to browse</p>
        <p className="upload-info">Supports: JPEG, PNG, HEIC • Max 10MB per file</p>
        <p className="upload-info">Text extraction powered by GPT-4 Vision</p>
      </div>

      {uploads.size > 0 && (
        <div className="upload-progress-list">
          {Array.from(uploads.values()).map((upload) => (
            <div key={upload.fileName} className={`upload-item ${upload.status}`}>
              <div className="upload-item-header">
                <span className="file-name">{upload.fileName}</span>
                <span className="upload-status-icon">
                  {upload.status === 'uploading' && '⬆️'}
                  {upload.status === 'uploaded' && '✅'}
                  {upload.status === 'completed' && '✅'}
                  {upload.status === 'failed' && '❌'}
                </span>
              </div>
              
              {upload.status !== 'failed' && (
                <div className="progress-bar">
                  <div 
                    className="progress-fill" 
                    style={{ width: `${upload.progress}%` }}
                  />
                </div>
              )}
              
              <div className="upload-item-footer">
                {upload.status === 'uploading' && (
                  <span className="status-text">Uploading... {Math.round(upload.progress)}%</span>
                )}
                {upload.status === 'uploaded' && (
                  <span className="status-text">Upload complete! Processing will begin shortly...</span>
                )}
                {upload.status === 'completed' && (
                  <span className="status-text success">Uploaded! Check gallery for processing status.</span>
                )}
                {upload.status === 'failed' && (
                  <span className="status-text error">{upload.error}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


