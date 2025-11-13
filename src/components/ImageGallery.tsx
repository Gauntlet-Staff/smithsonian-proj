import { useState, useEffect } from 'react';
import { collection, query, where, orderBy, onSnapshot, Timestamp, addDoc, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import '../styles/ImageGallery.css';
import ReactMarkdown from 'react-markdown';

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
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportDepth, setReportDepth] = useState<'brief' | 'standard' | 'comprehensive'>('standard');
  const [reportStyle, setReportStyle] = useState<'casual' | 'professional' | 'academic'>('professional');
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

  // Load most recent completed report on mount
  useEffect(() => {
    if (!currentUser) return;

    const q = query(
      collection(db, 'reports'),
      where('userId', '==', currentUser.uid),
      where('status', '==', 'completed'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const mostRecentReport = snapshot.docs[0].data();
        if (mostRecentReport.report) {
          setGeneratedReport(mostRecentReport.report);
          // Restore selected images from the report
          if (mostRecentReport.imageIds && Array.isArray(mostRecentReport.imageIds)) {
            setSelectedImageIds(new Set(mostRecentReport.imageIds));
          }
        }
      }
    });

    return () => unsubscribe();
  }, [currentUser]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  // Generate Report Handler - Creates Firestore document that triggers Cloud Function to generate report
  const handleGenerateReport = async () => {
    if (selectedImageIds.size === 0 || !reportPrompt.trim() || !currentUser) return;
    
    setShowReportModal(false); // Close modal
    setGenerating(true);
    setGeneratedReport(''); // Clear previous report
    
    try {
      // Get all selected images with their extracted text and URLs
      const selectedImages = images.filter(img => selectedImageIds.has(img.id));
      const combinedTexts = selectedImages.map(img => 
        `--- ${img.fileName} ---\n${img.extractedText}\n`
      ).join('\n');
      
      // Prepare image data for Vision analysis
      const imageData = selectedImages.map(img => ({
        fileName: img.fileName,
        imageUrl: img.imageUrl,
        extractedText: img.extractedText
      }));
      
      // Create a report document in Firestore - this triggers the Cloud Function
      const reportRef = await addDoc(collection(db, 'reports'), {
        userId: currentUser.uid,
        combinedTexts,
        imageData, // Pass images for Vision analysis
        prompt: reportPrompt,
        imageIds: Array.from(selectedImageIds),
        reportDepth,
        reportStyle,
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

        {/* Configure Report button */}
        {selectedImageIds.size > 0 && (
          <div style={{
            padding: '20px',
            background: '#f9fafb',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            gap: '12px'
          }}>
            <button
              onClick={() => setShowReportModal(true)}
              disabled={generating}
              style={{
                padding: '12px 24px',
                background: generating ? '#9ca3af' : '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: generating ? 'not-allowed' : 'pointer',
                fontSize: '16px',
                fontWeight: 600
              }}
            >
              {generating ? '🔄 Generating Report...' : '📄 Configure Report'}
            </button>
            <span style={{ color: '#6b7280', fontSize: '14px' }}>
              {selectedImageIds.size} image{selectedImageIds.size > 1 ? 's' : ''} selected
            </span>
          </div>
        )}

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
                  onClick={async () => {
                    const { marked } = await import('marked');
                    
                    // Convert markdown to HTML
                    const htmlContent = await marked(generatedReport);
                    
                    // Create a complete HTML document with same styling as display
                    const styledHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Museum Report</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      padding: 40px;
      max-width: 1000px;
      margin: 0 auto;
      background: #ffffff;
      color: #374151;
    }
    h1 {
      font-size: 28px;
      font-weight: 700;
      margin-top: 24px;
      margin-bottom: 16px;
      color: #1f2937;
    }
    h2 {
      font-size: 24px;
      font-weight: 600;
      margin-top: 20px;
      margin-bottom: 12px;
      color: #374151;
    }
    h3 {
      font-size: 20px;
      font-weight: 600;
      margin-top: 16px;
      margin-bottom: 10px;
      color: #4b5563;
    }
    h4 {
      font-size: 18px;
      font-weight: 600;
      margin-top: 14px;
      margin-bottom: 8px;
      color: #6b7280;
    }
    p {
      margin-top: 12px;
      margin-bottom: 12px;
      color: #374151;
    }
    ul, ol {
      margin-left: 24px;
      margin-top: 8px;
      margin-bottom: 8px;
    }
    li {
      margin-top: 6px;
      margin-bottom: 6px;
      padding-left: 8px;
    }
    strong {
      font-weight: 700;
      color: #1f2937;
    }
    @media print {
      body { padding: 20px; }
    }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;
                    
                    // Create blob and download as .doc (HTML format that Word opens)
                    const blob = new Blob([styledHTML], { type: 'application/msword' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `museum-report-${Date.now()}.doc`;
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
                  💾 Download (.doc)
                </button>
                <button
                  onClick={() => setShowReportModal(true)}
                  style={{
                    padding: '8px 16px',
                    background: '#8b5cf6',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  🔄 Regenerate
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
              background: '#f9fafb',
              padding: '16px',
              borderRadius: '8px',
              fontSize: '14px',
              lineHeight: '1.6',
              maxHeight: '500px',
              overflowY: 'auto',
              border: '1px solid #e5e7eb'
            }}>
              <ReactMarkdown
                components={{
                  h1: ({node, ...props}) => <h1 style={{ fontSize: '28px', fontWeight: '700', marginTop: '24px', marginBottom: '16px', color: '#1f2937' }} {...props} />,
                  h2: ({node, ...props}) => <h2 style={{ fontSize: '24px', fontWeight: '600', marginTop: '20px', marginBottom: '12px', color: '#374151' }} {...props} />,
                  h3: ({node, ...props}) => <h3 style={{ fontSize: '20px', fontWeight: '600', marginTop: '16px', marginBottom: '10px', color: '#4b5563' }} {...props} />,
                  h4: ({node, ...props}) => <h4 style={{ fontSize: '18px', fontWeight: '600', marginTop: '14px', marginBottom: '8px', color: '#6b7280' }} {...props} />,
                  p: ({node, ...props}) => <p style={{ marginTop: '12px', marginBottom: '12px', color: '#374151' }} {...props} />,
                  ul: ({node, ...props}) => <ul style={{ marginLeft: '24px', marginTop: '8px', marginBottom: '8px', listStyleType: 'disc' }} {...props} />,
                  ol: ({node, ...props}) => <ol style={{ marginLeft: '24px', marginTop: '8px', marginBottom: '8px' }} {...props} />,
                  li: ({node, ...props}) => <li style={{ marginTop: '6px', marginBottom: '6px', paddingLeft: '8px' }} {...props} />,
                  strong: ({node, ...props}) => <strong style={{ fontWeight: '700', color: '#1f2937' }} {...props} />,
                }}
              >
                {generatedReport}
              </ReactMarkdown>
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
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
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

      {/* Report Configuration Modal */}
      {showReportModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }} onClick={() => setShowReportModal(false)}>
          <div style={{
            background: 'white',
            borderRadius: '12px',
            padding: '32px',
            maxWidth: '600px',
            width: '90%',
            maxHeight: '90vh',
            overflowY: 'auto'
          }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: '24px', fontSize: '24px', fontWeight: 600 }}>
              📄 Configure Report
            </h2>

            {/* Prompt Textarea */}
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px' }}>
                Report Prompt
              </label>
              <textarea
                value={reportPrompt}
                onChange={(e) => setReportPrompt(e.target.value)}
                placeholder="Enter your custom prompt for the report..."
                style={{
                  width: '100%',
                  minHeight: '120px',
                  padding: '12px',
                  borderRadius: '6px',
                  border: '1px solid #d1d5db',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  resize: 'vertical'
                }}
              />
            </div>

            {/* Report Depth Selector */}
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px' }}>
                📊 Report Depth: <span style={{ color: '#6b7280', textTransform: 'capitalize' }}>{reportDepth}</span>
              </label>
              <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
                {['brief', 'standard', 'comprehensive'].map((depth) => (
                  <button
                    key={depth}
                    onClick={() => setReportDepth(depth as 'brief' | 'standard' | 'comprehensive')}
                    style={{
                      flex: 1,
                      padding: '12px',
                      background: reportDepth === depth ? '#10b981' : '#f3f4f6',
                      color: reportDepth === depth ? 'white' : '#374151',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: 500,
                      textTransform: 'capitalize'
                    }}
                  >
                    {depth}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: '12px', color: '#6b7280', marginTop: '8px' }}>
                {reportDepth === 'brief' && 'High-level overview with key findings'}
                {reportDepth === 'standard' && 'Balanced analysis with important details'}
                {reportDepth === 'comprehensive' && 'In-depth documentation and extensive analysis'}
              </p>
            </div>

            {/* Report Style Selector */}
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px' }}>
                📝 Report Style: <span style={{ color: '#6b7280', textTransform: 'capitalize' }}>{reportStyle}</span>
              </label>
              <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
                {['casual', 'professional', 'academic'].map((style) => (
                  <button
                    key={style}
                    onClick={() => setReportStyle(style as 'casual' | 'professional' | 'academic')}
                    style={{
                      flex: 1,
                      padding: '12px',
                      background: reportStyle === style ? '#3b82f6' : '#f3f4f6',
                      color: reportStyle === style ? 'white' : '#374151',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: 500,
                      textTransform: 'capitalize'
                    }}
                  >
                    {style}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: '12px', color: '#6b7280', marginTop: '8px' }}>
                {reportStyle === 'casual' && 'Easy to read, conversational tone'}
                {reportStyle === 'professional' && 'Balanced, museum-standard language'}
                {reportStyle === 'academic' && 'Formal, scholarly terminology'}
              </p>
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowReportModal(false)}
                style={{
                  padding: '10px 20px',
                  background: '#f3f4f6',
                  color: '#374151',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 500
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateReport}
                disabled={!reportPrompt.trim()}
                style={{
                  padding: '10px 20px',
                  background: !reportPrompt.trim() ? '#9ca3af' : '#10b981',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: !reportPrompt.trim() ? 'not-allowed' : 'pointer',
                  fontSize: '14px',
                  fontWeight: 600
                }}
              >
                📄 Generate Report
              </button>
            </div>
          </div>
        </div>
      )}
      </>
    );
  }

