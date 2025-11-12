# Cloud Functions Setup - Gemini AI Text Extraction

This document explains the Cloud Functions implementation for automatic text extraction using Google's Gemini AI (Vertex AI).

## Architecture Overview

### Flow
1. User uploads image → Firebase Storage
2. Frontend creates Firestore document with `status: 'pending'`
3. Cloud Function automatically triggered on document creation
4. Function downloads image, calls Gemini Vision API
5. Extracted text saved back to Firestore with `status: 'completed'`
6. Frontend real-time listeners update UI automatically

## Cloud Functions

### 1. `extractTextFromImage`
**Type:** Firestore Trigger (onCreate)
**Trigger:** `images/{imageId}` collection

Automatically processes images when new documents are created.

**Process:**
1. Validates document has required fields (`imageUrl`, `userId`)
2. Updates status to `'processing'`
3. Downloads image from Firebase Storage
4. Converts to base64 and determines MIME type
5. Calls Gemini 1.5 Flash model with structured prompt
6. Updates Firestore with extracted text
7. Sets status to `'completed'` or `'failed'`

**Prompt Strategy:**
The function uses a detailed prompt that instructs Gemini to:
- Extract all visible text (printed and handwritten)
- Maintain original layout and structure
- Include labels, signs, documents, numbers, and dates
- Return "No text detected" if no text found

### 2. `retryTextExtraction`
**Type:** Callable HTTPS Function

Allows manual retry of failed extractions.

**Usage:**
```typescript
const functions = getFunctions();
const retry = httpsCallable(functions, 'retryTextExtraction');
await retry({ imageId: 'doc-id' });
```

## Setup Instructions

### 1. Install Dependencies
```bash
cd functions
npm install
```

Dependencies installed:
- `firebase-admin@^12.6.0` - Firebase Admin SDK
- `firebase-functions@^6.0.1` - Cloud Functions SDK
- `@google-cloud/vertexai` - Vertex AI SDK for Gemini

### 2. Enable Required APIs

In Google Cloud Console:
1. **Vertex AI API** - For Gemini models
2. **Cloud Functions API** - Already enabled
3. **Cloud Storage API** - Already enabled

```bash
gcloud services enable aiplatform.googleapis.com
```

### 3. Deploy Functions

```bash
# Build TypeScript
npm run build

# Deploy all functions
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:extractTextFromImage
```

### 4. Test Functions Locally (Optional)

```bash
# Start emulators
npm run serve

# This will start:
# - Functions emulator
# - Firestore emulator (if needed)
```

## Configuration

### Model Selection
Current: `gemini-1.5-flash`
- Fast and cost-effective
- Good for text extraction
- Multimodal (image + text input)

To upgrade to Pro:
```typescript
const model = vertexAI.getGenerativeModel({
  model: "gemini-1.5-pro", // More accurate but slower/costlier
});
```

### Region
Current: `us-central1`

To change region, update in:
1. `functions/src/index.ts` - VertexAI location
2. Function options `region: "us-central1"`

### Cost Control
```typescript
setGlobalOptions({ maxInstances: 10 });
```

This limits concurrent executions to control costs.

## Firestore Document Structure

### Before Processing
```json
{
  "userId": "uid123",
  "imageUrl": "https://storage.googleapis.com/...",
  "fileName": "photo.jpg",
  "fileSize": 1024000,
  "uploadedAt": Timestamp,
  "status": "pending",
  "extractedText": ""
}
```

### During Processing
```json
{
  "status": "processing",
  // ... other fields unchanged
}
```

### After Success
```json
{
  "status": "completed",
  "extractedText": "Text found in image...",
  "processedAt": Timestamp,
  // ... other fields
}
```

### After Failure
```json
{
  "status": "failed",
  "error": "Error message",
  "processedAt": Timestamp,
  "extractedText": ""
}
```

## Security Rules

### Firestore
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /images/{imageId} {
      // Users can only read/write their own images
      allow read: if request.auth != null && 
                     request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && 
                       request.auth.uid == request.resource.data.userId &&
                       request.resource.data.status == 'pending';
      // Cloud Functions can update any document
      allow update: if request.auth.token.admin == true;
    }
  }
}
```

### Storage
```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /images/{userId}/{imageId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## Error Handling

Common errors and solutions:

### "Permission denied"
- **Cause:** Vertex AI API not enabled or insufficient permissions
- **Solution:** Enable API and ensure Firebase has Vertex AI permissions

### "File not found" or "Download error"
- **Cause:** Storage path mismatch
- **Solution:** Check Storage bucket configuration in Firebase Admin

### "Model not found"
- **Cause:** Model name incorrect or not available in region
- **Solution:** Verify model name and region availability

### "Quota exceeded"
- **Cause:** Too many API calls
- **Solution:** Increase quota or implement rate limiting

## Monitoring

### View Logs
```bash
# Real-time logs
firebase functions:log

# Specific function
firebase functions:log --only extractTextFromImage
```

### In Console
- **Firebase Console:** Functions → Logs
- **Google Cloud Console:** Logging → Logs Explorer

### Metrics to Monitor
- Invocations count
- Execution time (should be 3-10 seconds typically)
- Error rate
- Vertex AI API usage

## Cost Estimation

### Gemini 1.5 Flash Pricing (as of 2024)
- Images: ~$0.0001 per image
- Text generation: ~$0.00001 per 1K characters

### Cloud Functions
- Invocations: 2M free/month
- Compute time: 400K GB-seconds/month free
- After free tier: ~$0.40 per million invocations

**Example:** 1,000 images/month
- Gemini: ~$0.10
- Functions: Free (within tier)
- **Total:** ~$0.10/month

## Optimization Tips

1. **Batch Processing:** Process multiple images in one invocation if needed
2. **Caching:** Store common results to avoid re-processing
3. **Timeout:** Current default is 60s, increase if needed for large images
4. **Retry Logic:** Already implemented in `retryTextExtraction`

## Troubleshooting

### Function Not Triggering
1. Check Firestore security rules allow writes
2. Verify function deployed: `firebase functions:list`
3. Check logs for errors: `firebase functions:log`

### Poor Text Extraction
1. Try Gemini 1.5 Pro for better accuracy
2. Adjust prompt for specific use cases
3. Ensure image quality is sufficient

### Slow Performance
1. Check network latency to Vertex AI
2. Consider using `gemini-1.5-flash` (faster)
3. Optimize image size before upload

## Development Workflow

1. **Local Development:**
   ```bash
   npm run build:watch  # Auto-rebuild on changes
   ```

2. **Test with Emulators:**
   ```bash
   firebase emulators:start
   ```

3. **Deploy to Staging:**
   ```bash
   firebase use staging
   firebase deploy --only functions
   ```

4. **Deploy to Production:**
   ```bash
   firebase use production
   firebase deploy --only functions
   ```

## Next Steps

- [ ] Add thumbnail generation
- [ ] Implement batch processing for multiple images
- [ ] Add support for PDF documents
- [ ] Create admin dashboard for monitoring
- [ ] Implement cost alerts and quotas
- [ ] Add language detection and translation

## Resources

- [Vertex AI Documentation](https://cloud.google.com/vertex-ai/docs)
- [Gemini API Reference](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/gemini)
- [Firebase Functions Documentation](https://firebase.google.com/docs/functions)
- [Cloud Functions Pricing](https://firebase.google.com/pricing)



