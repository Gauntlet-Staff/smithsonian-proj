# Smithsonian Test Image Scripts

Scripts to download and upload 500 diverse Smithsonian Open Access images for testing the batch report generation feature.

## Setup

### 1. Install Dependencies

```bash
cd scripts
npm install
```

### 2. Get Your User ID

1. Go to https://smithsonian-proj.web.app
2. Sign in
3. Open browser console (F12)
4. Run: `firebase.auth().currentUser.uid`
5. Copy the user ID (looks like: `abc123xyz...`)

### 3. Download Service Account Key (for upload)

1. Go to [Firebase Console](https://console.firebase.google.com/project/smithsonian-proj/settings/serviceaccounts/adminsdk)
2. Click "Generate new private key"
3. Save as `scripts/serviceAccountKey.json`
4. **NEVER commit this file to git!** (already in .gitignore)

## Usage

### Step 1: Download Images from Smithsonian

Downloads 500 diverse images organized by category:

```bash
npm run download
```

Or specify a different number:

```bash
npm run download 100  # Download 100 images
npm run download 1000 # Download 1000 images
```

**What it downloads:**
- 100 Documents (letters, manuscripts)
- 100 Artifacts (historical objects)
- 80 Manuscripts (handwritten documents)
- 60 Posters (with text and graphics)
- 60 Photographs (historical photos)
- 50 Paintings (artwork)
- 50 Sculptures (3D objects)

**Output:**
```
smithsonian-test-images/
├── Documents/
│   ├── Documents-1.jpg
│   ├── Documents-2.jpg
│   └── ...
├── Artifacts/
│   ├── Artifacts-1.jpg
│   └── ...
├── Manuscripts/
├── Posters/
├── Photographs/
├── Paintings/
├── Sculptures/
└── metadata.json
```

**Time:** ~10-15 minutes for 500 images

### Step 2: Upload to Firebase

**Option A: With Text Extraction (Slower, uses GPT-4o Vision)**

```bash
npm run upload YOUR_USER_ID
```

This will:
- Upload all images to Firebase Storage
- Create Firestore documents with `status: 'pending'`
- Trigger Cloud Functions for text extraction
- **Time:** 20-30 minutes for 500 images (GPT-4o processing)

**Option B: Skip Text Extraction (Faster, uses mock data)**

```bash
npm run upload YOUR_USER_ID --skip-extraction
```

This will:
- Upload all images to Firebase Storage
- Create Firestore documents with `status: 'completed'`
- Use mock extracted text (based on metadata)
- **Time:** 5-10 minutes for 500 images

**Recommended for testing:** Use `--skip-extraction` for quick testing, then test with real extraction separately.

### Step 3: Test Report Generation

1. Go to https://smithsonian-proj.web.app
2. You'll see your 500 test images
3. Click "Select All"
4. Click "Configure Report"
5. Generate report with 500 images!

## Examples

### Quick Test (10 minutes total)

```bash
# Download 100 images
npm run download 100

# Upload with mock text
npm run upload YOUR_USER_ID --skip-extraction
```

### Full Test (45 minutes total)

```bash
# Download 500 images
npm run download

# Upload with real text extraction
npm run upload YOUR_USER_ID
```

### Massive Test (2-3 hours total)

```bash
# Download 1000 images
npm run download 1000

# Upload with mock text
npm run upload YOUR_USER_ID --skip-extraction
```

## Cleanup

To delete all test images from Firebase:

```bash
# Coming soon: cleanup script
```

Or manually:
1. Go to Firebase Console > Firestore
2. Delete all documents in `images` collection
3. Go to Firebase Console > Storage
4. Delete all files in your user folder

## Troubleshooting

### "metadata.json not found"

Run the download script first:
```bash
npm run download
```

### "serviceAccountKey.json not found"

Download the service account key from Firebase Console (see Setup step 3)

### "Permission denied"

Make sure you're using YOUR user ID, not someone else's

### Download is slow

The Smithsonian API has rate limits. The script respects these with delays.

### Some images fail to download

This is normal. The script will skip failed images and continue.

## Image Categories Explained

- **Documents**: Letters, official papers with typed/printed text
- **Artifacts**: Physical objects, tools, historical items
- **Manuscripts**: Handwritten documents, old scripts
- **Posters**: Advertising, informational posters with text
- **Photographs**: Historical photographs, portraits
- **Paintings**: Artwork, paintings, illustrations
- **Sculptures**: 3D objects, statues, carved items

These provide diverse test cases for:
- Text extraction (various fonts, handwriting)
- Image analysis (different object types)
- Report generation (mixed content)

