import admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Firebase Admin using Application Default Credentials
// This will use the Firebase CLI credentials you're already logged in with
admin.initializeApp({
  projectId: 'smithsonian-proj',
  storageBucket: 'smithsonian-proj.firebasestorage.app'
});

const storage = admin.storage().bucket();
const firestore = admin.firestore();

interface ImageMetadata {
  filename: string;
  category: string;
  title: string;
  description?: string;
  originalUrl: string;
  smithsonianId: string;
}

async function uploadToFirebase(
  imagesDir: string,
  userId: string,
  skipTextExtraction: boolean = false
) {
  console.log('🚀 Firebase Bulk Upload Starting...');
  console.log('='.repeat(50));

  // Read metadata
  const metadataPath = path.join(imagesDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error('metadata.json not found! Run download script first.');
  }

  const metadata: ImageMetadata[] = JSON.parse(
    fs.readFileSync(metadataPath, 'utf-8')
  );

  console.log(`📂 Found ${metadata.length} images to upload`);
  console.log(`👤 Uploading as user: ${userId}`);
  console.log(`📝 Text extraction: ${skipTextExtraction ? 'SKIP (mock data)' : 'ENABLED'}\n`);

  let uploadedCount = 0;
  let failedCount = 0;

  for (const item of metadata) {
    try {
      const localPath = path.join(imagesDir, item.category, item.filename);
      
      if (!fs.existsSync(localPath)) {
        console.warn(`⚠️  File not found: ${localPath}`);
        failedCount++;
        continue;
      }

      // Upload to Storage
      const storagePath = `${userId}/${Date.now()}-${item.filename}`;
      console.log(`📤 [${uploadedCount + 1}/${metadata.length}] Uploading ${item.filename}...`);

      await storage.upload(localPath, {
        destination: storagePath,
        metadata: {
          contentType: getMimeType(item.filename),
          metadata: {
            originalTitle: item.title,
            category: item.category,
            smithsonianId: item.smithsonianId
          }
        }
      });

      // Get download URL
      const file = storage.file(storagePath);
      await file.makePublic();
      const publicUrl = `https://storage.googleapis.com/${storage.name}/${storagePath}`;

      // Get file stats
      const stats = fs.statSync(localPath);

      // Create Firestore document
      const firestoreDoc = {
        userId,
        imageUrl: publicUrl,
        fileName: item.filename,
        fileSize: stats.size,
        uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: skipTextExtraction ? 'completed' : 'pending',
        extractedText: skipTextExtraction ? generateMockText(item) : '',
        metadata: {
          category: item.category,
          title: item.title,
          description: item.description || '',
          smithsonianId: item.smithsonianId,
          originalUrl: item.originalUrl
        }
      };

      await firestore.collection('images').add(firestoreDoc);

      uploadedCount++;
      
      if (uploadedCount % 10 === 0) {
        console.log(`✅ Progress: ${uploadedCount}/${metadata.length} uploaded`);
      }

      // Rate limiting
      await sleep(200);

    } catch (error) {
      console.error(`❌ Failed to upload ${item.filename}:`, error);
      failedCount++;
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Successfully uploaded: ${uploadedCount}`);
  console.log(`❌ Failed: ${failedCount}`);
  console.log('\n🎉 Upload complete! Check your Firebase console.');
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff'
  };
  return mimeTypes[ext] || 'image/jpeg';
}

function generateMockText(item: ImageMetadata): string {
  return `${item.title}

Category: ${item.category}
Description: ${item.description || 'Historical artifact from the Smithsonian collection.'}

Smithsonian ID: ${item.smithsonianId}

This is a ${item.category.toLowerCase()} artifact that demonstrates historical significance. The item shows characteristics typical of its period and provides valuable insights into the collection.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the script
const imagesDirectory = path.join(process.cwd(), 'smithsonian-test-images');
const userId = process.argv[2];
const skipExtraction = process.argv[3] === '--skip-extraction';

if (!userId) {
  console.error('❌ Error: User ID is required!');
  console.log('\nUsage:');
  console.log('  npm run upload YOUR_USER_ID');
  console.log('  npm run upload YOUR_USER_ID --skip-extraction (faster, uses mock text)');
  console.log('\nExample:');
  console.log('  npm run upload abc123xyz');
  process.exit(1);
}

console.log(`Starting upload from ${imagesDirectory}...\n`);

uploadToFirebase(imagesDirectory, userId, skipExtraction)
  .then(() => {
    console.log('\n✅ All done! Your test images are ready in Firebase.');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Upload failed:', error);
    process.exit(1);
  });

