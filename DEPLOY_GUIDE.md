# Quick Start - Deploy Cloud Functions

## Prerequisites
- Firebase CLI installed: `npm install -g firebase-tools`
- Logged in: `firebase login`
- Project selected: `firebase use your-project-id`

## Step 1: Enable Vertex AI API

```bash
# Using gcloud CLI
gcloud services enable aiplatform.googleapis.com

# Or visit: https://console.cloud.google.com/apis/library/aiplatform.googleapis.com
```

## Step 2: Build and Deploy

```bash
cd functions
npm install
npm run build
firebase deploy --only functions
```

## Step 3: Update Firestore Security Rules

Go to Firebase Console → Firestore Database → Rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /images/{imageId} {
      allow read: if request.auth != null && 
                     request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && 
                       request.auth.uid == request.resource.data.userId;
      allow update: if request.auth != null && 
                       request.auth.uid == resource.data.userId;
    }
  }
}
```

## Step 4: Test

1. Upload an image in your app
2. Check Firebase Console → Firestore → `images` collection
3. Watch status change: `pending` → `processing` → `completed`
4. View logs: `firebase functions:log`

## Expected Timeline

- Image upload: 1-2 seconds
- Status `pending` → `processing`: < 1 second (function trigger)
- Status `processing` → `completed`: 3-10 seconds (Gemini processing)
- Total: ~5-12 seconds from upload to text extraction

## Troubleshooting

### "Permission denied" on deployment
```bash
firebase login --reauth
```

### Functions not triggering
```bash
# Check if deployed
firebase functions:list

# View logs
firebase functions:log --only extractTextFromImage
```

### Vertex AI errors
- Ensure API is enabled
- Check project has billing enabled
- Verify region is supported (us-central1)

## Monitor Costs

- Firebase Console → Usage and billing
- Set budget alerts in Google Cloud Console
- Expected: ~$0.0001 per image processed

## Done! 🎉

Your app now uses Gemini AI for text extraction instead of client-side OCR.



