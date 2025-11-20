import { useState, useEffect } from 'react';
import { collection, query, where, orderBy, onSnapshot, Timestamp, addDoc, doc, deleteDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import '../styles/ImageGallery.css';
import ReactMarkdown from 'react-markdown';
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

// Template Interfaces
interface TemplateSection {
  name: string;
  type: 'single' | 'section'; // 'single' = field, 'section' = section with sub-headings
  subHeadings: string[];
}

interface ReportTemplate {
  id?: string; // Firestore document ID
  templateName: string;
  sections: TemplateSection[];
  userId?: string;
  createdAt?: Date;
}

// Default template
const DEFAULT_TEMPLATE: ReportTemplate = {
  templateName: "Historical Analysis (Default)",
  sections: [
    { name: "Title", type: "single", subHeadings: [] },
    { name: "Historical Significance", type: "section", subHeadings: ["Date", "Significance"] },
    { name: "Physical Condition", type: "section", subHeadings: ["Materials", "Condition"] },
    { name: "Preservation", type: "section", subHeadings: ["Recommendations"] }
  ]
};


export default function ImageGallery({ refreshTrigger }: { refreshTrigger: number }) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  
  const [images, setImages] = useState<ImageDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedImage, setSelectedImage] = useState<ImageDocument | null>(null);
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set());
  const [reportPrompt, setReportPrompt] = useState<string>(
    'For each exhibit, analyze:\n\nHistorical Significance - What is it? When is it from? Why is it important?\n\nPhysical Condition - What materials? Current condition? Any damage, wear, fading?\n\nPreservation - What conservation is needed? How should it be stored?'
  );
  const [generating, setGenerating] = useState(false);
  const [generatedReport, setGeneratedReport] = useState<string>('');
  const [currentReportId, setCurrentReportId] = useState<string | null>(null);
  const [reportProgress, setReportProgress] = useState<{imagesProcessed: number; totalImages: number; message: string} | null>(null);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportDepth, setReportDepth] = useState<'brief' | 'standard' | 'comprehensive'>('standard');
  const [reportStyle, setReportStyle] = useState<'casual' | 'professional' | 'academic'>('professional');
  
  // Template state management
  const [savedTemplates, setSavedTemplates] = useState<ReportTemplate[]>([]);
  const [currentTemplate, setCurrentTemplate] = useState<ReportTemplate>(DEFAULT_TEMPLATE);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  
  const { currentUser } = useAuth();

  // Helper function: Clean report formatting for consistent display (template-aware)
  const cleanReportFormatting = (reportText: string, template?: ReportTemplate): string => {
    let cleaned = reportText;
    const activeTemplate = template || currentTemplate;
    
    // Standardize "Exhibit #X" to "EXHIBIT X" (all caps, remove #, make bold)
    cleaned = cleaned.replace(/\*{0,2}Exhibit\s*#?\s*(\d+)\*{0,2}/gi, '**EXHIBIT $1**');
    
    // Extract section and sub-heading names from template
    const sectionNames = activeTemplate.sections
      .filter(s => s.type === 'section')
      .map(s => s.name);
    
    const allHeadings = [
      ...activeTemplate.sections.filter(s => s.type === 'single').map(s => s.name),
      ...activeTemplate.sections.flatMap(s => s.subHeadings)
    ];
    
    // Split sub-headers that are on the same line (dynamic based on template)
    if (allHeadings.length > 0) {
      const escapedHeadings = allHeadings.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const headingPattern = escapedHeadings.join('|');
      cleaned = cleaned.replace(
        new RegExp(`\\*{0,2}(${headingPattern}):\\*{0,2}\\s*([^\\n]+?)\\s+\\*{0,2}(${headingPattern}):`, 'gi'),
        '**$1:** $2\n\n**$3:'
      );
    }
    
    // Make section headers BOLD (dynamic)
    sectionNames.forEach(sectionName => {
      const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(
        new RegExp(`^(${escapedName})$`, 'gmi'),
        '**$1**'
      );
    });
    
    // Remove numbered list prefixes from section headings (dynamic)
    sectionNames.forEach(sectionName => {
      const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(
        new RegExp(`^\\s*\\d+\\.\\s+(${escapedName}):?`, 'gmi'),
        '**$1**'
      );
    });
    
    // Remove bullet point prefixes from section headings (dynamic)
    sectionNames.forEach(sectionName => {
      const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(
        new RegExp(`^\\s*[•\\-*]\\s+(${escapedName}):?`, 'gmi'),
        '**$1**'
      );
    });
    
    // Remove colons after section headers (dynamic)
    sectionNames.forEach(sectionName => {
      const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(
        new RegExp(`^(${escapedName}):\\s*`, 'gmi'),
        '**$1**\n\n'
      );
    });
    
    // Make sub-headers BOLD and add line breaks (dynamic)
    allHeadings.forEach(heading => {
      const escapedName = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(
        new RegExp(`(${escapedName}:)`, 'g'),
        '\n**$1**'
      );
    });
    
    // Clean up multiple newlines
    return cleaned.replace(/\n{3,}/g, '\n\n');
  };

  // Firestore functions for templates
  const loadUserTemplates = async () => {
    if (!currentUser) return;
    
    try {
      const templatesQuery = query(
        collection(db, 'reportTemplates'),
        where('userId', '==', currentUser.uid),
        orderBy('createdAt', 'desc')
      );
      
      const unsubscribe = onSnapshot(templatesQuery, (snapshot) => {
        const templates = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        } as ReportTemplate));
        setSavedTemplates(templates);
      });
      
      return unsubscribe;
    } catch (error) {
      console.error('Error loading templates:', error);
    }
  };

  const saveTemplate = async (template: ReportTemplate) => {
    if (!currentUser) return;
    
    try {
      // Clean template: filter out empty sub-headings
      const cleanedSections = template.sections.map(section => ({
        ...section,
        subHeadings: section.subHeadings.filter(sh => sh.trim())
      }));
      
      const templateData: any = {
        templateName: template.templateName,
        sections: cleanedSections,
        userId: currentUser.uid,
        createdAt: serverTimestamp()
      };
      
      if (template.id) {
        // Update existing template (remove createdAt for updates)
        delete templateData.createdAt;
        templateData.updatedAt = serverTimestamp();
        await updateDoc(doc(db, 'reportTemplates', template.id), templateData);
        alert('Template updated successfully!');
      } else {
        // Create new template
        const docRef = await addDoc(collection(db, 'reportTemplates'), templateData);
        // Update currentTemplate with the new ID so future saves update instead of creating duplicates
        setCurrentTemplate({
          ...template,
          id: docRef.id,
          sections: cleanedSections
        });
        alert('Template saved successfully!');
      }
      
      // Close the modal after saving
      setShowTemplateModal(false);
    } catch (error) {
      console.error('Error saving template:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      alert(`Failed to save template: ${errorMessage}`);
    }
  };

  const deleteTemplate = async (templateId: string) => {
    if (!window.confirm('Delete this template?')) return;
    
    try {
      await deleteDoc(doc(db, 'reportTemplates', templateId));
      alert('Template deleted successfully!');
    } catch (error) {
      console.error('Error deleting template:', error);
      alert('Failed to delete template. Please try again.');
    }
  };

  // Load user's saved templates on mount
  useEffect(() => {
    const unsubscribe = loadUserTemplates();
    return () => {
      if (unsubscribe) {
        unsubscribe.then(unsub => unsub && unsub());
      }
    };
  }, [currentUser]);

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
    
    const unsubscribe = onSnapshot(reportDocRef, async (snapshot) => {
      const data = snapshot.data();
      
      if (!data) return;

      // Update progress if available
      if (data.progress) {
        setReportProgress(data.progress);
      }

      if (data.status === 'completed') {
        await loadReport(data);
        setGenerating(false);
        setReportProgress(null); // Clear progress
        alert('Report generated successfully!');
        setCurrentReportId(null); // Stop listening
      } else if (data.status === 'failed') {
        setGenerating(false);
        setReportProgress(null); // Clear progress
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
  // Helper function to load report (from Storage URL or directly from Firestore)
  const loadReport = async (reportData: any) => {
    if (reportData.reportUrl) {
      // Large report stored in Storage
      try {
        const response = await fetch(reportData.reportUrl);
        const reportText = await response.text();
        setGeneratedReport(reportText);
      } catch (error) {
        console.error('Error fetching report from Storage:', error);
        alert('Failed to load report from storage');
      }
    } else if (reportData.report) {
      // Small report stored directly in Firestore
      setGeneratedReport(reportData.report);
    }
  };

  useEffect(() => {
    if (!currentUser) return;

    const q = query(
      collection(db, 'reports'),
      where('userId', '==', currentUser.uid),
      where('status', '==', 'completed'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      if (!snapshot.empty) {
        const mostRecentReport = snapshot.docs[0].data();
        await loadReport(mostRecentReport);
        // Restore selected images from the report
        if (mostRecentReport.imageIds && Array.isArray(mostRecentReport.imageIds)) {
          setSelectedImageIds(new Set(mostRecentReport.imageIds));
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
    setReportProgress(null); // Clear previous progress
    
    try {
      // Get all selected images
      const selectedImages = images.filter(img => selectedImageIds.has(img.id));
      
      // Clean template before sending: filter out empty sub-headings
      const cleanedTemplate = {
        ...currentTemplate,
        sections: currentTemplate.sections.map(section => ({
          ...section,
          subHeadings: section.subHeadings.filter(sh => sh.trim())
        }))
      };
      
      // Create a report document in Firestore - this triggers the Cloud Function
      // Only pass imageIds - the Cloud Function will fetch full data from Firestore
      const reportRef = await addDoc(collection(db, 'reports'), {
        userId: currentUser.uid,
        prompt: reportPrompt,
        imageIds: Array.from(selectedImageIds),
        imageCount: selectedImages.length,
        reportDepth,
        reportStyle,
        template: cleanedTemplate, // Pass cleaned template structure
        status: 'pending',
        createdAt: serverTimestamp()
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
              {generating ? (
                reportProgress ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', width: '100%' }}>
                    <div style={{ fontSize: '14px' }}>
                      Processing {reportProgress.imagesProcessed} out of {reportProgress.totalImages} images
                    </div>
                    <div style={{ 
                      width: '100%', 
                      height: '6px', 
                      background: '#e5e7eb', 
                      borderRadius: '3px', 
                      overflow: 'hidden' 
                    }}>
                      <div style={{ 
                        height: '100%', 
                        background: '#3b82f6', 
                        width: `${Math.round((reportProgress.imagesProcessed / reportProgress.totalImages) * 100)}%`,
                        transition: 'width 0.3s ease'
                      }}></div>
                    </div>
                  </div>
                ) : '🔄 Starting...'
              ) : '📄 Configure Report'}
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
                    
                    // Clean formatting before converting to HTML
                    const cleanedReport = cleanReportFormatting(generatedReport);
                    
                    // Convert markdown to HTML
                    const htmlContent = await marked(cleanedReport);
                    
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
                  ol: ({node, ...props}) => <ol style={{ marginLeft: '0', marginTop: '8px', marginBottom: '8px', listStyleType: 'none' }} {...props} />,
                  li: ({node, ...props}) => <li style={{ marginTop: '6px', marginBottom: '6px', paddingLeft: '0', listStyleType: 'none' }} {...props} />,
                  strong: ({node, ...props}) => <strong style={{ fontWeight: '700', color: '#1f2937' }} {...props} />,
                }}
              >
                {cleanReportFormatting(generatedReport)}
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

            {/* Template Manager Section */}
            <div style={{ marginBottom: '24px', padding: '16px', background: '#f9fafb', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px' }}>📋 Report Template</h3>
              
              {/* Template Selector */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500, color: '#6b7280' }}>
                  Select Template
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <select 
                    value={currentTemplate.id || 'default'}
                    onChange={(e) => {
                      if (e.target.value === 'default') {
                        setCurrentTemplate(DEFAULT_TEMPLATE);
                      } else {
                        const selected = savedTemplates.find(t => t.id === e.target.value);
                        if (selected) setCurrentTemplate(selected);
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: '8px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '14px'
                    }}
                  >
                    <option value="default">{DEFAULT_TEMPLATE.templateName}</option>
                    {savedTemplates.map(t => (
                      <option key={t.id} value={t.id}>{t.templateName}</option>
                    ))}
                  </select>
                  <button 
                    onClick={() => setShowTemplateModal(true)} 
                    style={{
                      padding: '8px 12px',
                      background: '#3b82f6',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    ✏️ Edit
                  </button>
                  <button 
                    onClick={() => {
                      setCurrentTemplate({
                        templateName: 'New Template',
                        sections: [
                          { name: 'Title', type: 'single', subHeadings: [] }
                        ]
                      });
                      setShowTemplateModal(true);
                    }} 
                    style={{
                      padding: '8px 12px',
                      background: '#10b981',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    ➕ New
                  </button>
                </div>
              </div>
              
              {/* Template Preview */}
              <div style={{ padding: '12px', background: 'white', borderRadius: '6px', border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '8px', color: '#374151' }}>Structure:</div>
                <ul style={{ marginLeft: '20px', fontSize: '13px', color: '#6b7280' }}>
                  <li><strong>EXHIBIT [NUMBER]</strong> (always present)</li>
                  {currentTemplate.sections.map((section, idx) => (
                    <li key={idx}>
                      <strong>{section.name}</strong>
                      {section.type === 'section' && section.subHeadings.length > 0 && (
                        <ul style={{ marginLeft: '16px', marginTop: '4px' }}>
                          {section.subHeadings.map(sh => <li key={sh}>{sh}</li>)}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

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

      {/* Template Editor Modal */}
      {showTemplateModal && (
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
          zIndex: 1001
        }} onClick={() => setShowTemplateModal(false)}>
          <div style={{
            background: 'white',
            borderRadius: '12px',
            padding: '32px',
            maxWidth: '700px',
            width: '90%',
            maxHeight: '90vh',
            overflowY: 'auto'
          }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: '24px', fontSize: '24px', fontWeight: 600 }}>
              {currentTemplate.id ? '📝 Edit Template' : '➕ Create New Template'}
            </h2>

            {/* Template Name */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '14px' }}>
                Template Name
              </label>
              <input
                type="text"
                value={currentTemplate.templateName}
                onChange={(e) => setCurrentTemplate({...currentTemplate, templateName: e.target.value})}
                placeholder="e.g., Art Analysis, Document Review"
                style={{
                  width: '100%',
                  padding: '10px',
                  borderRadius: '6px',
                  border: '1px solid #d1d5db',
                  fontSize: '14px'
                }}
              />
            </div>

            {/* Sections Editor */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <label style={{ fontWeight: 500, fontSize: '14px' }}>
                  Sections & Sub-headings
                </label>
                <button 
                  onClick={() => {
                    setCurrentTemplate({
                      ...currentTemplate,
                      sections: [...currentTemplate.sections, { name: 'New Section', type: 'section', subHeadings: [] }]
                    });
                  }}
                  style={{
                    padding: '6px 12px',
                    background: '#10b981',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '13px'
                  }}
                >
                  + Add Section
                </button>
              </div>

              {/* Section List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {currentTemplate.sections.map((section, idx) => (
                  <div key={idx} style={{ padding: '16px', background: '#f9fafb', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                      {/* Section Name */}
                      <input
                        type="text"
                        value={section.name}
                        onChange={(e) => {
                          const newSections = [...currentTemplate.sections];
                          newSections[idx].name = e.target.value;
                          setCurrentTemplate({...currentTemplate, sections: newSections});
                        }}
                        placeholder="Section name"
                        style={{
                          flex: 1,
                          padding: '8px',
                          borderRadius: '6px',
                          border: '1px solid #d1d5db',
                          fontSize: '14px',
                          fontWeight: 500
                        }}
                      />
                      
                      {/* Section Type Toggle */}
                      <select
                        value={section.type}
                        onChange={(e) => {
                          const newSections = [...currentTemplate.sections];
                          newSections[idx].type = e.target.value as 'single' | 'section';
                          setCurrentTemplate({...currentTemplate, sections: newSections});
                        }}
                        style={{
                          padding: '8px',
                          borderRadius: '6px',
                          border: '1px solid #d1d5db',
                          fontSize: '13px'
                        }}
                      >
                        <option value="single">Field</option>
                        <option value="section">Section</option>
                      </select>
                      
                      {/* Remove Section Button */}
                      <button 
                        onClick={() => {
                          const newSections = currentTemplate.sections.filter((_, i) => i !== idx);
                          setCurrentTemplate({...currentTemplate, sections: newSections});
                        }}
                        style={{
                          padding: '8px 12px',
                          background: '#ef4444',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '13px'
                        }}
                      >
                        ✕
                      </button>
                    </div>

                    {/* Sub-headings (only for 'section' type) */}
                    {section.type === 'section' && (
                      <div>
                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', fontWeight: 500, color: '#6b7280' }}>
                          Sub-headings (comma-separated):
                        </label>
                        <input
                          type="text"
                          value={section.subHeadings.join(', ')}
                          onChange={(e) => {
                            const newSections = [...currentTemplate.sections];
                            // Don't filter empty strings while typing - only trim individual items
                            newSections[idx].subHeadings = e.target.value.split(',').map(s => s.trim());
                            setCurrentTemplate({...currentTemplate, sections: newSections});
                          }}
                          placeholder="e.g., Date, Significance, Materials"
                          style={{
                            width: '100%',
                            padding: '8px',
                            borderRadius: '6px',
                            border: '1px solid #d1d5db',
                            fontSize: '13px'
                          }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                {currentTemplate.id && (
                  <button
                    onClick={async () => {
                      await deleteTemplate(currentTemplate.id!);
                      setCurrentTemplate(DEFAULT_TEMPLATE);
                      setShowTemplateModal(false);
                    }}
                    style={{
                      padding: '10px 20px',
                      background: '#ef4444',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: 500
                    }}
                  >
                    🗑️ Delete
                  </button>
                )}
              </div>
              
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setShowTemplateModal(false)}
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
                  onClick={async () => {
                    await saveTemplate(currentTemplate);
                  }}
                  disabled={!currentTemplate.templateName.trim() || currentTemplate.sections.length === 0}
                  style={{
                    padding: '10px 20px',
                    background: (!currentTemplate.templateName.trim() || currentTemplate.sections.length === 0) ? '#9ca3af' : '#10b981',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: (!currentTemplate.templateName.trim() || currentTemplate.sections.length === 0) ? 'not-allowed' : 'pointer',
                    fontSize: '14px',
                    fontWeight: 600
                  }}
                >
                  {currentTemplate.id ? '💾 Update Template' : '➕ Create Template'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      </>
    );
  }

