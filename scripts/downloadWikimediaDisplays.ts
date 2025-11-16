import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';

// Wikimedia Commons API
const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';

// Search queries for museum display photos with English text/placards
const SEARCH_QUERIES = [
  'museum exhibit display english',
  'museum placard label description',
  'museum case information card',
  'exhibit text panel english',
  'museum artifact label',
  'gallery display description',
  'museum exhibition text',
  'artifact information placard',
  'museum label english text',
  'exhibit description card'
];

interface WikiImage {
  title: string;
  url: string;
  descriptionUrl: string;
  description: string;
}

async function searchWikimedia(query: string, limit: number = 50): Promise<string[]> {
  try {
    const url = `${WIKIMEDIA_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=${limit}&format=json`;
    const response = await fetch(url);
    const data: any = await response.json();
    
    if (data.query && data.query.search) {
      return data.query.search.map((item: any) => item.title);
    }
    return [];
  } catch (error) {
    console.error(`Error searching Wikimedia for "${query}":`, error);
    return [];
  }
}

async function getImageInfo(title: string): Promise<WikiImage | null> {
  try {
    const url = `${WIKIMEDIA_API}?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|extmetadata&format=json`;
    const response = await fetch(url);
    const data: any = await response.json();
    
    const pages = data.query?.pages;
    if (!pages) return null;
    
    const page = Object.values(pages)[0] as any;
    const imageInfo = page.imageinfo?.[0];
    
    if (!imageInfo) return null;
    
    return {
      title: title.replace('File:', ''),
      url: imageInfo.url,
      descriptionUrl: imageInfo.descriptionurl,
      description: imageInfo.extmetadata?.ImageDescription?.value || 'No description'
    };
  } catch (error) {
    return null;
  }
}

async function downloadImage(imageUrl: string, outputPath: string): Promise<boolean> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return false;
    
    const buffer = await response.buffer();
    fs.writeFileSync(outputPath, buffer);
    return true;
  } catch (error) {
    return false;
  }
}

async function downloadWikimediaDisplays(outputDir: string, targetCount: number = 500) {
  console.log('🏛️  Wikimedia Museum Display Downloader');
  console.log('='.repeat(60));
  console.log(`Target: ${targetCount} display images with English text\n`);

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const metadata: any[] = [];
  let downloadedCount = 0;
  const seenTitles = new Set<string>();

  console.log('🔍 Searching Wikimedia Commons for museum displays...\n');

  for (const query of SEARCH_QUERIES) {
    if (downloadedCount >= targetCount) break;

    console.log(`  Searching: "${query}"...`);
    const titles = await searchWikimedia(query, 100);
    console.log(`    Found ${titles.length} potential images\n`);
    
    for (const title of titles) {
      if (downloadedCount >= targetCount) break;
      if (seenTitles.has(title)) continue;
      
      seenTitles.add(title);

      try {
        const imageInfo = await getImageInfo(title);
        
        if (!imageInfo) {
          await sleep(100);
          continue;
        }

        // Filter for image files only
        const filename = imageInfo.title.toLowerCase();
        if (!filename.endsWith('.jpg') && !filename.endsWith('.jpeg') && 
            !filename.endsWith('.png') && !filename.endsWith('.webp')) {
          continue;
        }

        // Skip very large files (> 10MB) for faster downloads
        const sizeCheck = await fetch(imageInfo.url, { method: 'HEAD' });
        const contentLength = parseInt(sizeCheck.headers.get('content-length') || '0');
        if (contentLength > 10 * 1024 * 1024) {
          console.log(`  ⚠️  Skipping large file: ${imageInfo.title.substring(0, 50)}...`);
          continue;
        }

        const ext = path.extname(imageInfo.title);
        const safeFilename = `display-${downloadedCount + 1}${ext}`;
        const filepath = path.join(outputDir, safeFilename);

        console.log(`[${downloadedCount + 1}/${targetCount}] ${safeFilename}`);
        console.log(`  Title: ${imageInfo.title.substring(0, 60)}${imageInfo.title.length > 60 ? '...' : ''}`);

        const success = await downloadImage(imageInfo.url, filepath);
        
        if (success) {
          downloadedCount++;
          
          metadata.push({
            filename: safeFilename,
            originalTitle: imageInfo.title,
            description: imageInfo.description.substring(0, 200),
            wikimediaUrl: imageInfo.descriptionUrl,
            imageUrl: imageInfo.url
          });

          // Save metadata every 25 images
          if (downloadedCount % 25 === 0) {
            fs.writeFileSync(
              path.join(outputDir, 'metadata.json'),
              JSON.stringify(metadata, null, 2)
            );
            console.log(`  ✅ Checkpoint: ${downloadedCount}/${targetCount} saved\n`);
          }
        } else {
          console.log(`  ❌ Download failed\n`);
        }

        // Rate limiting
        await sleep(300);

      } catch (error) {
        console.error(`  ❌ Error processing ${title}\n`);
      }
    }

    // Wait between search queries
    await sleep(1000);
  }

  // Final metadata save
  fs.writeFileSync(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  console.log('\n' + '='.repeat(60));
  console.log(`✅ Downloaded ${downloadedCount} museum display images`);
  console.log(`📂 Location: ${outputDir}`);
  console.log(`📄 Metadata: ${path.join(outputDir, 'metadata.json')}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the script
const outputDirectory = path.join(process.cwd(), 'smithsonian-test-images');
const imageCount = parseInt(process.argv[2]) || 500;

downloadWikimediaDisplays(outputDirectory, imageCount)
  .then(() => {
    console.log('\n🎉 Download complete!');
    console.log('\n📌 Next steps:');
    console.log('  1. Review images in: smithsonian-test-images/');
    console.log('  2. Upload to Firebase: npm run upload YOUR_USER_ID');
  })
  .catch(error => {
    console.error('\n❌ Error:', error);
    process.exit(1);
  });

