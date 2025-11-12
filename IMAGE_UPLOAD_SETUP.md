# Smithsonian Image Archive Project

A React + TypeScript + Firebase application for bulk image upload with automatic text extraction using OCR.

## Features

### 🖼️ Image Upload
- **Bulk Upload**: Upload multiple images at once
- **Drag & Drop**: Drag and drop images directly into the upload zone
- **File Picker**: Traditional file selection dialog
- **Supported Formats**: JPEG, PNG, HEIC (iPhone photos)
- **File Size Limit**: 10MB per image

### 🔍 Text Extraction
- **Client-Side OCR**: Uses Tesseract.js for text recognition
- **Automatic Processing**: Text is extracted automatically after upload
- **Progress Tracking**: Real-time progress bars for upload and processing

### 💾 Storage
- **Firebase Storage**: Images stored in Firebase Cloud Storage
- **Firestore Database**: Metadata and extracted text stored in Firestore
- **User-Specific**: Each user can only see their own images

### 🎨 User Interface
- **Modern Design**: Clean and intuitive interface
- **Image Gallery**: Grid view of all uploaded images
- **Detail Modal**: Click any image to view full resolution and complete extracted text
- **Error Handling**: Visual feedback for failed uploads with error messages
- **Status Indicators**: 
  - ⬆️ Uploading
  - 🔄 Processing (extracting text)
  - ✅ Completed
  - ❌ Failed

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Firebase
Create a `.env` file in the root directory with your Firebase credentials:

```env
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
```

### 3. Firebase Console Setup

#### Enable Authentication
1. Go to Firebase Console → Authentication
2. Enable Email/Password sign-in method
3. (Optional) Enable Google sign-in

#### Enable Firestore
1. Go to Firebase Console → Firestore Database
2. Create database in production mode
3. Set up security rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /images/{imageId} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.userId;
    }
  }
}
```

#### Enable Storage
1. Go to Firebase Console → Storage
2. Get Started and enable Storage
3. Set up security rules:

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /images/{userId}/{imageId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

### 4. Run Development Server
```bash
npm run dev
```

## Technology Stack

- **Frontend**: React 19 + TypeScript
- **Build Tool**: Vite
- **Authentication**: Firebase Auth
- **Database**: Cloud Firestore
- **Storage**: Firebase Cloud Storage
- **OCR**: Tesseract.js (client-side)
- **Styling**: CSS3 with modern features

## Data Model

### Firestore Collection: `images`
```typescript
{
  id: string;           // Auto-generated document ID
  userId: string;       // User ID from Firebase Auth
  imageUrl: string;     // Download URL from Storage
  extractedText: string;// OCR extracted text
  fileName: string;     // Original file name
  fileSize: number;     // File size in bytes
  uploadedAt: Timestamp;// Upload timestamp
  status: string;       // 'completed' | 'failed'
}
```

## File Structure

```
src/
├── components/
│   ├── ImageUploader.tsx  # Upload component with drag-drop
│   └── ImageGallery.tsx   # Gallery display component
├── contexts/
│   └── AuthContext.tsx    # Authentication context
├── pages/
│   ├── Dashboard.tsx      # Main dashboard page
│   └── Login.tsx          # Login page
├── styles/
│   ├── Dashboard.css
│   ├── ImageUploader.css
│   ├── ImageGallery.css
│   └── Login.css
├── types/
│   └── image.ts           # TypeScript interfaces
├── firebase.ts            # Firebase configuration
└── main.tsx              # App entry point
```

## Features in Detail

### Upload Process
1. User selects or drops images
2. Files are validated (type, size)
3. Images uploaded to Firebase Storage
4. Progress bar shows upload status (0-50%)
5. Text extraction begins with Tesseract.js
6. Progress bar shows processing status (50-100%)
7. Metadata saved to Firestore
8. Image appears in gallery

### Gallery Features
- Real-time updates using Firestore listeners
- Lazy loading for images
- Click to view full details
- Extracted text preview in grid view
- Full extracted text in modal view

## Notes

- **OCR Accuracy**: Tesseract.js works best with clear, high-contrast text. Handwritten text or complex layouts may have reduced accuracy.
- **Performance**: OCR processing happens in the browser, which may be slower for very large images or bulk uploads. For better performance, consider implementing Cloud Functions with Google Cloud Vision API in the future.
- **HEIC Support**: Browser support for HEIC format is limited. The app accepts HEIC files, but they may need conversion on some browsers.

## Future Enhancements

- [ ] Implement Google Cloud Vision API via Cloud Functions for better OCR accuracy
- [ ] Add image thumbnail generation
- [ ] Implement search/filter functionality
- [ ] Add bulk delete capability
- [ ] Export extracted text to CSV/JSON
- [ ] Add image editing capabilities
- [ ] Implement pagination for large galleries

## License

MIT



