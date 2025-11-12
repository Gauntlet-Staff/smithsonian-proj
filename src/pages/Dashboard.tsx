import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import ImageUploader from '../components/ImageUploader';
import ImageGallery from '../components/ImageGallery';
import '../styles/Dashboard.css';

export default function Dashboard() {
  const { currentUser, signOut } = useAuth();
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  };

  const handleUploadComplete = () => {
    // Trigger gallery refresh
    setRefreshTrigger(prev => prev + 1);
  };

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Image Archive</h1>
        <div className="user-info">
          <span className="user-email">{currentUser?.email}</span>
          <button onClick={handleSignOut} className="btn-signout">
            Sign Out
          </button>
        </div>
      </header>
      
      <main className="dashboard-content">
        <section className="upload-section">
          <ImageUploader onUploadComplete={handleUploadComplete} />
        </section>

        <section className="gallery-section">
          <ImageGallery refreshTrigger={refreshTrigger} />
        </section>
      </main>
    </div>
  );
}

