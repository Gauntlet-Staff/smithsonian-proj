import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';

// Download images from public domain sources with ACTUAL text
// Sources: Library of Congress, Internet Archive, Comic Book Plus

const OUTPUT_DIR = path.join(process.cwd(), 'smithsonian-test-images');
const TARGET_COUNT = 500;

interface ImageItem {
  url: string;
  title: string;
  source: string;
  category: string;
  date?: string;
}

// ===== LIBRARY OF CONGRESS =====
// Historic newspapers, letters, documents with English text
async function fetchLibraryOfCongress(): Promise<ImageItem[]> {
  console.log('📰 Fetching from Library of Congress...');
  const items: ImageItem[] = [];
  
  // Search for newspapers - EXPANDED searches
  const searches = [
    'newspaper', 'letter', 'document', 'manuscript',
    'correspondence', 'telegram', 'postcard', 'diary',
    'gazette', 'journal', 'newsletter', 'periodical',
    'pamphlet', 'broadside', 'circular', 'notice'
  ];
  
  for (const query of searches) {
    try {
      // LOC API: https://www.loc.gov/apis/json-and-yaml/
      const url = `https://www.loc.gov/search/?q=${encodeURIComponent(query)}&fo=json&c=200&at=results`;
      const response = await fetch(url);
      const data: any = await response.json();
      
      if (data.results) {
        for (const result of data.results.slice(0, 100)) {
          if (result.image_url && result.image_url[0]) {
            items.push({
              url: result.image_url[0],
              title: result.title || 'Untitled',
              source: 'Library of Congress',
              category: query === 'newspaper' ? 'Newspapers' : 
                       query === 'letter' ? 'Letters' : 'Documents',
              date: result.date || 'Unknown'
            });
          }
        }
      }
      
      console.log(`  Found ${items.length} items from "${query}"`);
      await sleep(1000); // Rate limiting
    } catch (error) {
      console.error(`  Error searching LOC for "${query}":`, error);
    }
  }
  
  return items;
}

// ===== INTERNET ARCHIVE =====
// Books, newspapers, documents
async function fetchInternetArchive(): Promise<ImageItem[]> {
  console.log('📚 Fetching from Internet Archive...');
  const items: ImageItem[] = [];
  
  const searches = [
    'mediatype:texts AND language:eng AND newspaper',
    'mediatype:texts AND language:eng AND letter',
    'mediatype:texts AND language:eng AND comic',
    'mediatype:texts AND language:eng AND gazette',
    'mediatype:texts AND language:eng AND journal',
    'mediatype:texts AND language:eng AND correspondence',
    'mediatype:texts AND language:eng AND periodical',
    'mediatype:texts AND language:eng AND magazine'
  ];
  
  for (const query of searches) {
    try {
      // Internet Archive API - fetch 100 items per query
      const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier,title,date&rows=100&page=1&output=json`;
      const response = await fetch(url);
      const data: any = await response.json();
      
      if (data.response && data.response.docs) {
        for (const doc of data.response.docs) {
          // Get first page image
          const imageUrl = `https://archive.org/services/img/${doc.identifier}`;
          items.push({
            url: imageUrl,
            title: doc.title || 'Untitled',
            source: 'Internet Archive',
            category: query.includes('newspaper') ? 'Newspapers' :
                     query.includes('letter') ? 'Letters' : 'Comics',
            date: doc.date || 'Unknown'
          });
        }
      }
      
      console.log(`  Found ${items.length} items total`);
      await sleep(1000);
    } catch (error) {
      console.error(`  Error searching Internet Archive:`, error);
    }
  }
  
  return items;
}

// ===== WIKISOURCE (English texts) =====
async function fetchWikisource(): Promise<ImageItem[]> {
  console.log('📖 Fetching from Wikisource (English texts)...');
  const items: ImageItem[] = [];
  
  // Wikisource has scanned book pages with English text
  const searches = [
    'Shakespeare',
    'Dickens',
    'Mark Twain',
    'American literature'
  ];
  
  for (const query of searches) {
    try {
      const url = `https://en.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=0&srlimit=50&format=json`;
      const response = await fetch(url);
      const data: any = await response.json();
      
      if (data.query && data.query.search) {
        // Note: Wikisource doesn't directly provide images, would need to scrape pages
        // Skipping for now due to complexity
      }
      
      await sleep(1000);
    } catch (error) {
      console.error(`  Error searching Wikisource:`, error);
    }
  }
  
  return items;
}

// ===== DOWNLOAD FUNCTIONS =====
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

async function downloadAllImages() {
  console.log('🌐 Downloading images from public sources...');
  console.log('='.repeat(60));
  console.log(`Target: ${TARGET_COUNT} images\n`);
  
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  // Fetch from all sources
  console.log('🔍 Searching public sources...\n');
  
  const allItems: ImageItem[] = [
    ...await fetchLibraryOfCongress(),
    ...await fetchInternetArchive()
  ];
  
  console.log(`\n✅ Found ${allItems.length} total images`);
  console.log('\n📥 Starting download...\n');
  
  // Shuffle for variety
  const shuffled = allItems.sort(() => Math.random() - 0.5);
  
  let downloadedCount = 0;
  const metadata: any[] = [];
  
  for (const item of shuffled) {
    if (downloadedCount >= TARGET_COUNT) break;
    
    try {
      // Create category folder
      const categoryDir = path.join(OUTPUT_DIR, item.category);
      if (!fs.existsSync(categoryDir)) {
        fs.mkdirSync(categoryDir, { recursive: true });
      }
      
      const filename = `${item.category}-${downloadedCount + 1}.jpg`;
      const filepath = path.join(categoryDir, filename);
      
      console.log(`[${downloadedCount + 1}/${TARGET_COUNT}] ${filename}`);
      console.log(`  Title: ${item.title.substring(0, 60)}${item.title.length > 60 ? '...' : ''}`);
      console.log(`  Source: ${item.source}`);
      
      const success = await downloadImage(item.url, filepath);
      
      if (success) {
        downloadedCount++;
        
        metadata.push({
          filename,
          category: item.category,
          title: item.title,
          source: item.source,
          date: item.date,
          originalUrl: item.url
        });
        
        // Save metadata every 25 images
        if (downloadedCount % 25 === 0) {
          fs.writeFileSync(
            path.join(OUTPUT_DIR, 'metadata.json'),
            JSON.stringify(metadata, null, 2)
          );
          console.log(`  ✅ Checkpoint: ${downloadedCount}/${TARGET_COUNT} saved\n`);
        }
      } else {
        console.log(`  ❌ Download failed\n`);
      }
      
      // Rate limiting
      await sleep(500);
      
    } catch (error) {
      console.error(`  ❌ Error processing item\n`);
    }
  }
  
  // Final metadata save
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );
  
  console.log('\n' + '='.repeat(60));
  console.log(`✅ Downloaded ${downloadedCount} images`);
  console.log(`📂 Location: ${OUTPUT_DIR}`);
  console.log(`📄 Metadata: ${path.join(OUTPUT_DIR, 'metadata.json')}`);
  
  // Breakdown by category
  console.log('\n📊 Breakdown by category:');
  const counts: Record<string, number> = {};
  metadata.forEach(item => {
    counts[item.category] = (counts[item.category] || 0) + 1;
  });
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count} images`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run
downloadAllImages()
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

