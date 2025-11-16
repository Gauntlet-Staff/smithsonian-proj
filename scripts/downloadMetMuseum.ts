import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';

// Met Museum API - Free, no API key needed
const MET_API_BASE = 'https://collectionapi.metmuseum.org/public/collection/v1';

// ENGLISH-LANGUAGE text items only
// Prioritize: 1) English newspapers, 2) Comics, 3) English letters, 4) English books
const SEARCH_QUERIES = [
  // Old English/American newspapers
  'newspaper', 'New York Times', 'London news', 'American newspaper',
  
  // Comic books (English)
  'comic book', 'comic strip', 'cartoon',
  
  // English letters & correspondence
  'letter', 'correspondence', 'English letter',
  
  // Famous English authors
  'Shakespeare', 'Dickens', 'English book', 'American book'
];

interface MetObject {
  objectID: number;
  title: string;
  primaryImage: string;
  department: string;
  objectDate: string;
  medium: string;
  creditLine: string;
  searchQuery?: string; // Track which search found this item
}

async function searchMetMuseum(query: string): Promise<number[]> {
  try {
    const url = `${MET_API_BASE}/search?hasImages=true&q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const data: any = await response.json();
    return data.objectIDs || [];
  } catch (error) {
    console.error(`Error searching for "${query}":`, error);
    return [];
  }
}

async function getMetObject(objectID: number): Promise<MetObject | null> {
  try {
    const url = `${MET_API_BASE}/objects/${objectID}`;
    const response = await fetch(url);
    const data: any = await response.json();
    
    if (data.primaryImage) {
      const department = (data.department || '').toLowerCase();
      
      // FILTER OUT departments unlikely to have English text
      const excludeDepartments = [
        'asian art', 'islamic art', 'egyptian art', 
        'ancient near eastern art', 'greek and roman art',
        'arts of africa', 'oceania', 'japanese art',
        'chinese art', 'korean art', 'south asian art'
      ];
      
      const shouldExclude = excludeDepartments.some(dept => 
        department.includes(dept.toLowerCase())
      );
      
      if (shouldExclude) {
        return null; // Skip non-English departments
      }
      
      return {
        objectID: data.objectID,
        title: data.title || 'Untitled',
        primaryImage: data.primaryImage,
        department: data.department || 'Unknown',
        objectDate: data.objectDate || 'Unknown',
        medium: data.medium || 'Unknown',
        creditLine: data.creditLine || 'The Metropolitan Museum of Art'
      };
    }
    return null;
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

async function downloadMetMuseumImages(outputDir: string, targetCount: number = 500) {
  console.log('🏛️  Met Museum Image Downloader');
  console.log('='.repeat(60));
  console.log(`Target: ${targetCount} images\n`);

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const metadata: any[] = [];
  let downloadedCount = 0;
  const seenObjectIDs = new Set<number>();

  // Search for objects and track which query found them
  console.log('🔍 Searching Met Museum collection...\n');
  
  const objectsWithQuery: Array<{id: number, query: string}> = [];
  
  for (const query of SEARCH_QUERIES) {
    console.log(`  Searching: "${query}"...`);
    const objectIDs = await searchMetMuseum(query);
    
    // Add unique object IDs with their search query
    objectIDs.forEach(id => {
      if (!seenObjectIDs.has(id)) {
        seenObjectIDs.add(id);
        objectsWithQuery.push({id, query});
      }
    });
    
    console.log(`    Found ${objectIDs.length} items (${seenObjectIDs.size} unique total)`);
    await sleep(500); // Rate limiting
  }

  console.log(`\n✅ Total unique objects found: ${objectsWithQuery.length}`);
  console.log('\n📥 Starting download...\n');

  // Shuffle for variety
  const shuffled = objectsWithQuery.sort(() => Math.random() - 0.5);

  for (const item of shuffled) {
    if (downloadedCount >= targetCount) break;

    try {
      // Get object details
      const obj = await getMetObject(item.id);
      
      if (!obj) {
        await sleep(100);
        continue;
      }

      // Categorize based on which search query found it
      const category = categorizeBySearchQuery(item.query);
      const categoryDir = path.join(outputDir, category);
      
      if (!fs.existsSync(categoryDir)) {
        fs.mkdirSync(categoryDir, { recursive: true });
      }

      const filename = `${category}-${downloadedCount + 1}.jpg`;
      const filepath = path.join(categoryDir, filename);

      console.log(`[${downloadedCount + 1}/${targetCount}] ${filename}`);
      console.log(`  Title: ${obj.title.substring(0, 60)}${obj.title.length > 60 ? '...' : ''}`);
      console.log(`  Date: ${obj.objectDate}`);

      // Download image
      const success = await downloadImage(obj.primaryImage, filepath);
      
      if (success) {
        downloadedCount++;
        
        metadata.push({
          filename,
          category,
          objectID: obj.objectID,
          title: obj.title,
          date: obj.objectDate,
          department: obj.department,
          medium: obj.medium,
          creditLine: obj.creditLine,
          metUrl: `https://www.metmuseum.org/art/collection/search/${obj.objectID}`,
          imageUrl: obj.primaryImage
        });

        // Save metadata every 25 images
        if (downloadedCount % 25 === 0) {
          fs.writeFileSync(
            path.join(outputDir, 'metadata.json'),
            JSON.stringify(metadata, null, 2)
          );
          console.log(`\n  ✅ Checkpoint: ${downloadedCount}/${targetCount} saved\n`);
        }
      } else {
        console.log(`  ❌ Download failed\n`);
      }

      // Rate limiting
      await sleep(200);

    } catch (error) {
      console.error(`  ❌ Error processing object ${objectID}\n`);
    }
  }

  // Final metadata save
  fs.writeFileSync(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  console.log('\n' + '='.repeat(60));
  console.log(`✅ Downloaded ${downloadedCount} images`);
  console.log(`📂 Location: ${outputDir}`);
  console.log(`📄 Metadata: ${path.join(outputDir, 'metadata.json')}`);
  
  console.log('\n📊 Breakdown by category:');
  const counts: Record<string, number> = {};
  metadata.forEach(item => {
    counts[item.category] = (counts[item.category] || 0) + 1;
  });
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count} images`);
  });
}

// Map search queries to folder categories
function categorizeBySearchQuery(searchQuery: string): string {
  const queryMap: Record<string, string> = {
    // Newspapers
    'newspaper': 'Newspapers',
    'New York Times': 'Newspapers',
    'London news': 'Newspapers',
    'American newspaper': 'Newspapers',
    
    // Comics
    'comic book': 'Comics',
    'comic strip': 'Comics',
    'cartoon': 'Comics',
    
    // Letters
    'letter': 'Letters',
    'correspondence': 'Letters',
    'English letter': 'Letters',
    
    // Books
    'Shakespeare': 'English-Books',
    'Dickens': 'English-Books',
    'English book': 'English-Books',
    'American book': 'English-Books'
  };
  
  return queryMap[searchQuery] || 'Text-Items';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the script
const outputDirectory = path.join(process.cwd(), 'smithsonian-test-images');
const imageCount = parseInt(process.argv[2]) || 500;

downloadMetMuseumImages(outputDirectory, imageCount)
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

