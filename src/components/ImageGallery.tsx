import { useState, useEffect } from 'react';
import { collection, query, where, orderBy, onSnapshot, Timestamp, addDoc, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import '../styles/ImageGallery.css';

import { deleteDoc } from 'firebase/firestore';
import { ref, deleteObject } from 'firebase/storage';
import { storage } from '../firebase';

interface ImageDocument {
  id: string;
  userId: string;
  imageUrl: string;
  extractedText: string;
  fileName: string;
  fileSize: number;
  uploadedAt: Timestamp;
  status: string;
  error?: string; // Error message for failed extractions
}


export default function ImageGallery({ refreshTrigger }: { refreshTrigger: number }) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  
  const [images, setImages] = useState<ImageDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedImage, setSelectedImage] = useState<ImageDocument | null>(null);
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set());
  const [reportPrompt, setReportPrompt] = useState<string>(
    'Analyze these museum exhibits and create a comprehensive report highlighting historical significance, physical condition, and recommendations for preservation.'
  );
  const [generating, setGenerating] = useState(false);
  const [generatedReport, setGeneratedReport] = useState<string>('');
  const [currentReportId, setCurrentReportId] = useState<string | null>(null);
  const { currentUser } = useAuth();

  useEffect(() => {
    if (!currentUser) return;

    const q = query(
      collection(db, 'images'),
      where('userId', '==', currentUser.uid),
      orderBy('uploadedAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const imageData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as ImageDocument));
      
      setImages(imageData);
      setLoading(false);
    }, (error) => {
      console.error('Error fetching images:', error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [currentUser, refreshTrigger]);

  // Listen for report generation completion
  useEffect(() => {
    if (!currentReportId) return;

    const reportDocRef = doc(db, 'reports', currentReportId);
    
    const unsubscribe = onSnapshot(reportDocRef, (snapshot) => {
      const data = snapshot.data();
      
      if (!data) return;

      if (data.status === 'completed') {
        setGeneratedReport(data.report);
        setGenerating(false);
        alert('Report generated successfully!');
        setCurrentReportId(null); // Stop listening
      } else if (data.status === 'failed') {
        setGenerating(false);
        alert('Failed to generate report: ' + (data.error || 'Unknown error'));
        setCurrentReportId(null); // Stop listening
      }
    }, (error) => {
      console.error('Error listening to report:', error);
      setGenerating(false);
      alert('Failed to generate report. Please try again.');
      setCurrentReportId(null);
    });

    return () => unsubscribe();
  }, [currentReportId]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  // Generate Report Handler - Creates Firestore document that triggers Cloud Function to generate report
  const handleGenerateReport = async () => {
    if (selectedImageIds.size === 0 || !reportPrompt.trim() || !currentUser) return;
    
    setGenerating(true);
    setGeneratedReport(''); // Clear previous report
    
    try {
      // Get all selected images with their extracted text
      const selectedImages = images.filter(img => selectedImageIds.has(img.id));
      const combinedTexts = selectedImages.map(img => 
        `--- ${img.fileName} ---\n${img.extractedText}\n`
      ).join('\n');
      
      // Create a report document in Firestore - this triggers the Cloud Function
      const reportRef = await addDoc(collection(db, 'reports'), {
        userId: currentUser.uid,
        combinedTexts,
        prompt: reportPrompt,
        imageIds: Array.from(selectedImageIds),
        status: 'pending',
        createdAt: new Date()
      });
      
      setCurrentReportId(reportRef.id);
      
    } catch (error) {
      console.error('Report generation error:', error);
      alert('Failed to create report. Please try again.');
      setGenerating(false);
    }
  };

  const formatDate = (timestamp: Timestamp): string => {
    if (!timestamp) return 'Unknown date';
    const date = timestamp.toDate();
    
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleDelete = async (image: ImageDocument, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${image.fileName}"?`)) return;
    setDeletingId(image.id);
    try {
      // Try to delete from Storage, but continue even if file doesn't exist
      try {
        const storagePath = image.imageUrl.split('/o/')[1]?.split('?')[0];
        const decodedPath = decodeURIComponent(storagePath || '');
        const imageRef = ref(storage, decodedPath);
        await deleteObject(imageRef);
      } catch (storageError) {
        console.log('Storage file not found, deleting Firestore doc anyway');
      }
      
      // Always delete the Firestore document
      await deleteDoc(doc(db, 'images', image.id));
      
      if (selectedImage?.id === image.id) {
        setSelectedImage(null);
      }
    } catch (error) {
      console.error('Delete error:', error);
      alert('Failed to delete image');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="gallery-loading">
        <div className="spinner"></div>
        <p>Loading your images...</p>
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className="gallery-empty">
        <div className="empty-icon">📷</div>
        <h3>No images yet</h3>
        <p>Upload your first image to get started</p>
      </div>
    );
  }

  return (
    <>
      <div className="image-gallery">
        <div className="gallery-header">
          <h2>Your Images ({images.length})</h2>
        </div>

        {images.filter(img => img.status === 'completed').length > 0 && ( // Select All button (for report generation)
          <div style={{
            padding: '15px 20px',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            gap: '12px'
          }}>
            <button
              onClick={() => {
                const allCompleted = images.filter(img => img.status === 'completed');
                setSelectedImageIds(new Set(allCompleted.map(img => img.id)));
              }}
              style={{
                padding: '8px 16px',
                background: '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              Select All ({images.filter(img => img.status === 'completed').length})
            </button>

            <button
              onClick={() => setSelectedImageIds(new Set())}
              disabled={selectedImageIds.size === 0}
              style={{
                padding: '8px 16px',
                background: selectedImageIds.size === 0 ? '#d1d5db' : '#6b7280',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: selectedImageIds.size === 0 ? 'not-allowed' : 'pointer',
                fontSize: '14px'
              }}
            >
              Clear Selection
            </button>

            <span style={{ color: '#6b7280', fontSize: '14px', fontWeight: 500 }}>
              {selectedImageIds.size} selected
            </span>
          </div>
        )}

        {/* Report generation button starts here */}
        {selectedImageIds.size > 0 && (
          <div style={{
            padding: '20px',
            background: '#f9fafb',
            borderBottom: '1px solid #e5e7eb'
          }}>
            <h3 style={{ marginBottom: '12px', fontSize: '16px', fontWeight: 600 }}>
              Generate Report from {selectedImageIds.size} Image{selectedImageIds.size > 1 ? 's' : ''}
            </h3>

            <textarea
              value={reportPrompt}
              onChange={(e) => setReportPrompt(e.target.value)}
              placeholder="Enter your custom prompt for the report. Example: 'Analyze these museum exhibits and create a comprehensive report highlighting historical significance, physical condition, and recommendations for preservation.'"
              style={{
                width: '100%',
                minHeight: '100px',
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid #d1d5db',
                fontSize: '14px',
                fontFamily: 'inherit',
                resize: 'vertical',
                marginBottom: '12px'
              }}
            />

            <button
              onClick={handleGenerateReport}
              disabled={generating || !reportPrompt.trim()}
              style={{
                padding: '10px 20px',
                background: generating || !reportPrompt.trim() ? '#9ca3af' : '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: generating || !reportPrompt.trim() ? 'not-allowed' : 'pointer',
                fontSize: '14px',
                fontWeight: 600
              }}
            >
              {generating ? '🔄 Generating Report...' : '📄 Generate Report'}
            </button>
          </div>
        )} {/* Report generation button ends here */}

        {generatedReport && ( // Generated report starts here
          <div style={{
            padding: '20px',
            background: '#ffffff',
            borderBottom: '1px solid #e5e7eb',
            marginTop: '20px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 600 }}>📄 Generated Report</h3>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(generatedReport);
                    alert('Report copied to clipboard!');
                  }}
                  style={{
                    padding: '8px 16px',
                    background: '#3b82f6',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  📋 Copy
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([generatedReport], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `museum-report-${Date.now()}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{
                    padding: '8px 16px',
                    background: '#10b981',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  💾 Download
                </button>
                <button
                  onClick={() => setGeneratedReport('')}
                  style={{
                    padding: '8px 16px',
                    background: '#ef4444',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  ✕ Close
                </button>
              </div>
            </div>
            <div style={{
              whiteSpace: 'pre-wrap',
              background: '#f9fafb',
              padding: '16px',
              borderRadius: '8px',
              fontSize: '14px',
              lineHeight: '1.6',
              maxHeight: '500px',
              overflowY: 'auto',
              border: '1px solid #e5e7eb'
            }}>
              {generatedReport}
            </div>
          </div>
        )} {/* Generated report ends here */}

        <div className="gallery-grid">
          {images.map((image) => (
            <div 
              key={image.id} 
              className="gallery-item"
              onClick={() => setSelectedImage(image)}
            >
              <div className="gallery-item-image">
                <img src={image.imageUrl} alt={image.fileName} loading="lazy" />
                {image.status === 'pending' && (
                  <div className="status-overlay pending">
                    <span className="status-badge">⏳ Pending</span>
                  </div>
                )}
                {image.status === 'processing' && (
                  <div className="status-overlay processing">
                    <span className="status-badge">🔄 Processing...</span>
                  </div>
                )}
                {image.status === 'failed' && (
                  <div className="error-overlay">
                    <span className="error-icon">❌</span>
                  </div>
                )}
              </div>
              
              <div className="gallery-item-info">
                <h4 className="image-filename">{image.fileName}</h4>

                <button
                  onClick={(e) => handleDelete(image, e)}  // Delete button
                  disabled={deletingId === image.id}
                  style={{
                    background: '#ef4444',
                    color: 'white',
                    border: 'none',
                    padding: '6px 12px',
                    borderRadius: '4px',
                    cursor: deletingId === image.id ? 'wait' : 'pointer',
                    marginTop: '8px',
                    fontSize: '14px'
                  }}
                >
                  {deletingId === image.id ? 'Deleting...' : '🗑️ Delete'} 
                </button> {/* Delete button ends here */}

                <input  // Checkbox for selecting images (for report generation)
                  type="checkbox"
                  checked={selectedImageIds.has(image.id)}
                  onChange={(e) => {
                    e.stopPropagation();
                    const newSet = new Set(selectedImageIds);
                    if (e.target.checked) {
                      newSet.add(image.id);
                    } else {
                      newSet.delete(image.id);
                    }
                    setSelectedImageIds(newSet);
                  }}
                  disabled={image.status !== 'completed'}
                  style={{
                    marginTop: '8px',
                    width: '18px',
                    height: '18px',
                    cursor: image.status === 'completed' ? 'pointer' : 'not-allowed'
                  }}
                />
                {/* Checkbox for selecting images ends here */}

                <p className="image-date">{formatDate(image.uploadedAt)}</p>
                <p className="image-filesize">{formatFileSize(image.fileSize)}</p>
                
                {image.status === 'pending' && (
                  <div className="status-message pending-message">
                    <span className="status-icon">⏳</span>
                    <p>Waiting for text extraction...</p>
                  </div>
                )}
                {image.status === 'processing' && (
                  <div className="status-message processing-message">
                    <span className="status-icon">🔄</span>
                    <p>Extracting text with GPT-4 Vision...</p>
                  </div>
                )}
                {image.status === 'failed' && image.error && (
                  <div className="status-message error-message">
                    <span className="status-icon">❌</span>
                    <p>{image.error}</p>
                  </div>
                )}
                {image.status === 'completed' && image.extractedText && (
                  <div className="extracted-text-preview">
                    <span className="text-icon">📝</span>
                    <p>{image.extractedText.substring(0, 100)}
                      {image.extractedText.length > 100 ? '...' : ''}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Image Detail Modal */}
      {selectedImage && (
        <div className="image-modal" onClick={() => setSelectedImage(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedImage(null)}>
              ✕
            </button>
            
            <div className="modal-body">
              <div className="modal-image">
                <img src={selectedImage.imageUrl} alt={selectedImage.fileName} />
              </div>
              
              <div className="modal-details">
                <h2>{selectedImage.fileName}</h2>
                
                <div className="detail-row">
                  <span className="detail-label">Uploaded:</span>
                  <span className="detail-value">{formatDate(selectedImage.uploadedAt)}</span>
                </div>
                
                <div className="detail-row">
                  <span className="detail-label">Size:</span>
                  <span className="detail-value">{formatFileSize(selectedImage.fileSize)}</span>
                </div>
                
                <div className="detail-row">
                  <span className="detail-label">Status:</span>
                  <span className="detail-value">
                    {selectedImage.status === 'pending' && '⏳ Pending'}
                    {selectedImage.status === 'processing' && '🔄 Processing'}
                    {selectedImage.status === 'completed' && '✅ Completed'}
                    {selectedImage.status === 'failed' && '❌ Failed'}
                  </span>
                </div>
                
                <div className="extracted-text-full">
                  <h3>Extracted Text</h3>
                  {selectedImage.status === 'pending' && (
                    <div className="text-content status-waiting">
                      <p>⏳ Waiting for text extraction to begin...</p>
                    </div>
                  )}
                  {selectedImage.status === 'processing' && (
                    <div className="text-content status-processing">
                      <p>🔄 GPT-4 Vision is analyzing the image and extracting text...</p>
                    </div>
                  )}
                  {selectedImage.status === 'failed' && (
                    <div className="text-content status-error">
                      <p>❌ Text extraction failed</p>
                      {selectedImage.error && <p className="error-detail">{selectedImage.error}</p>}
                    </div>
                  )}
                  {selectedImage.status === 'completed' && (
                    <div className="text-content">
                      {selectedImage.extractedText || 'No text detected'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

