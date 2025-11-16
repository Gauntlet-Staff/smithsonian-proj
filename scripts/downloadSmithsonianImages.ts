import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';

// Smithsonian Open Access API
const API_BASE = 'https://api.si.edu/openaccess/api/v1.0';

// Different categories to get diverse samples
const SEARCH_QUERIES = [
  { query: 'letters', category: 'Documents', limit: 100 },
  { query: 'artifact', category: 'Artifacts', limit: 100 },
  { query: 'manuscript', category: 'Manuscripts', limit: 80 },
  { query: 'poster', category: 'Posters', limit: 60 },
  { query: 'photograph', category: 'Photographs', limit: 60 },
  { query: 'painting', category: 'Paintings', limit: 50 },
  { query: 'sculpture', category: 'Sculptures', limit: 50 }
];

interface SmithsonianImage {
  id: string;
  title: string;
  imageUrl: string;
  category: string;
  description?: string;
}

async function searchSmithsonian(query: string, limit: number): Promise<SmithsonianImage[]> {
  const results: SmithsonianImage[] = [];
  let start = 0;
  const rowsPerPage = 100;

  console.log(`🔍 Searching for "${query}"...`);

  while (results.length < limit) {
    try {
      const url = `${API_BASE}/search?q=${encodeURIComponent(query)}&start=${start}&rows=${rowsPerPage}&api_key=DEMO_KEY&media.type=Images`;
      
      const response = await fetch(url);
      const data: any = await response.json();

      if (!data.response || !data.response.rows || data.response.rows.length === 0) {
        console.log(`⚠️  No more results for "${query}"`);
        break;
      }

      for (const item of data.response.rows) {
        if (results.length >= limit) break;

        // Check if item has images
        if (item.content && item.content.descriptiveNonRepeating && 
            item.content.descriptiveNonRepeating.online_media && 
            item.content.descriptiveNonRepeating.online_media.media) {
          
          const media = item.content.descriptiveNonRepeating.online_media.media;
          
          // Find first image with good quality
          const imageMedia = media.find((m: any) => 
            m.type === 'Images' && m.content && m.content.includes('http')
          );

          if (imageMedia) {
            results.push({
              id: item.id,
              title: item.title || 'Untitled',
              imageUrl: imageMedia.content,
              category: query,
              description: item.content?.freetext?.notes?.[0]?.content || ''
            });
          }
        }
      }

      start += rowsPerPage;
      await sleep(1000); // Rate limiting
    } catch (error) {
      console.error(`❌ Error fetching data for "${query}":`, error);
      break;
    }
  }

  console.log(`✅ Found ${results.length} images for "${query}"`);
  return results;
}

async function downloadImage(imageUrl: string, outputPath: string): Promise<boolean> {
  try {
    // Try to get the thumbnail or medium size first
    let url = imageUrl;
    
    // Smithsonian images often have size parameters
    if (!url.includes('_thumbnail') && !url.includes('_screen')) {
      // Try to get a medium-sized version
      url = url.replace(/\.(jpg|jpeg|png)$/i, '_screen.$1');
    }

    const response = await fetch(url);
    
    if (!response.ok) {
      // Fallback to original URL
      const originalResponse = await fetch(imageUrl);
      if (!originalResponse.ok) {
        throw new Error(`HTTP ${originalResponse.status}`);
      }
      const buffer = await originalResponse.buffer();
      fs.writeFileSync(outputPath, buffer);
    } else {
      const buffer = await response.buffer();
      fs.writeFileSync(outputPath, buffer);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Failed to download image:`, error);
    return false;
  }
}

async function downloadSmithsonianDataset(outputDir: string, totalImages: number = 500) {
  console.log('🏛️  Smithsonian Open Access Image Downloader');
  console.log('='.repeat(50));
  
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create metadata file
  const metadata: any[] = [];
  let downloadedCount = 0;

  // Search and download from each category
  for (const searchQuery of SEARCH_QUERIES) {
    if (downloadedCount >= totalImages) break;

    const categoryDir = path.join(outputDir, searchQuery.category);
    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    const images = await searchSmithsonian(searchQuery.query, searchQuery.limit);
    
    for (let i = 0; i < images.length && downloadedCount < totalImages; i++) {
      const image = images[i];
      const ext = image.imageUrl.split('.').pop()?.split('?')[0] || 'jpg';
      const filename = `${searchQuery.category}-${i + 1}.${ext}`;
      const filepath = path.join(categoryDir, filename);

      console.log(`📥 Downloading ${downloadedCount + 1}/${totalImages}: ${filename}`);

      const success = await downloadImage(image.imageUrl, filepath);
      
      if (success) {
        downloadedCount++;
        
        metadata.push({
          filename,
          category: searchQuery.category,
          title: image.title,
          description: image.description,
          originalUrl: image.imageUrl,
          smithsonianId: image.id
        });

        // Save metadata every 10 images
        if (downloadedCount % 10 === 0) {
          fs.writeFileSync(
            path.join(outputDir, 'metadata.json'),
            JSON.stringify(metadata, null, 2)
          );
        }
      }

      await sleep(500); // Rate limiting
    }
  }

  // Final metadata save
  fs.writeFileSync(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Downloaded ${downloadedCount} images to ${outputDir}`);
  console.log(`📄 Metadata saved to ${path.join(outputDir, 'metadata.json')}`);
  console.log('\nImage breakdown:');
  
  const categoryCounts: Record<string, number> = {};
  metadata.forEach(item => {
    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
  });
  
  Object.entries(categoryCounts).forEach(([category, count]) => {
    console.log(`  - ${category}: ${count} images`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the script
const outputDirectory = path.join(process.cwd(), 'smithsonian-test-images');
const imageCount = parseInt(process.argv[2]) || 500;

console.log(`Starting download of ${imageCount} images...`);
console.log(`Output directory: ${outputDirectory}\n`);

downloadSmithsonianDataset(outputDirectory, imageCount)
  .then(() => {
    console.log('\n🎉 Done! You can now upload these images for testing.');
  })
  .catch(error => {
    console.error('\n❌ Error:', error);
    process.exit(1);
  });

