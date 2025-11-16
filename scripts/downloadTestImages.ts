import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';

// Use Lorem Picsum for reliable test images
const CATEGORIES = [
  'documents', 'artifacts', 'manuscripts', 'posters', 
  'photographs', 'paintings', 'sculptures', 'exhibits'
];

async function downloadTestImages(outputDir: string, totalImages: number = 500) {
  console.log('📥 Downloading Test Images...');
  console.log('='.repeat(50));
  console.log(`Target: ${totalImages} images\n`);

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const metadata: any[] = [];
  let downloadedCount = 0;
  const imagesPerCategory = Math.ceil(totalImages / CATEGORIES.length);

  for (const category of CATEGORIES) {
    if (downloadedCount >= totalImages) break;

    const categoryDir = path.join(outputDir, category);
    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    console.log(`\n📂 Category: ${category}`);
    console.log('-'.repeat(40));

    for (let i = 0; i < imagesPerCategory && downloadedCount < totalImages; i++) {
      try {
        // Random seed for variety
        const seed = downloadedCount + 1;
        const width = 800 + Math.floor(Math.random() * 400); // 800-1200px
        const height = 600 + Math.floor(Math.random() * 400); // 600-1000px
        
        const imageUrl = `https://picsum.photos/seed/${seed}/${width}/${height}`;
        const filename = `${category}-${i + 1}.jpg`;
        const filepath = path.join(categoryDir, filename);

        console.log(`  [${downloadedCount + 1}/${totalImages}] ${filename}`);

        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const buffer = await response.buffer();
        fs.writeFileSync(filepath, buffer);

        metadata.push({
          filename,
          category,
          title: `Test ${category} Exhibit ${i + 1}`,
          description: generateDescription(category, i + 1),
          localPath: filepath
        });

        downloadedCount++;

        // Progress update every 50 images
        if (downloadedCount % 50 === 0) {
          console.log(`\n✅ Progress: ${downloadedCount}/${totalImages}\n`);
        }

        // Small delay to avoid rate limiting
        await sleep(100);

      } catch (error) {
        console.error(`  ❌ Failed: ${error}`);
      }
    }
  }

  // Save metadata
  fs.writeFileSync(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Downloaded ${downloadedCount} images`);
  console.log(`📂 Location: ${outputDir}`);
  console.log(`📄 Metadata: ${path.join(outputDir, 'metadata.json')}`);
  
  console.log('\nBreakdown by category:');
  const counts: Record<string, number> = {};
  metadata.forEach(item => {
    counts[item.category] = (counts[item.category] || 0) + 1;
  });
  Object.entries(counts).forEach(([cat, count]) => {
    console.log(`  - ${cat}: ${count} images`);
  });
}

function generateDescription(category: string, num: number): string {
  const templates: Record<string, string[]> = {
    documents: [
      `Historical document from ${1800 + num} with printed text. Shows official correspondence and formal letterhead.`,
      `Archival letter dated ${1850 + num}. Contains handwritten notes and signatures. Well-preserved paper.`,
      `Government record from early ${Math.floor(1900 + num / 10)}s. Typed document with stamps and seals.`
    ],
    artifacts: [
      `Ancient artifact from ${1000 + num * 10} BCE. Made of bronze/ceramic. Shows signs of age and patina.`,
      `Historical tool or implement. Dimensions approximately 15cm. Used for daily activities.`,
      `Cultural artifact displaying craftsmanship. Materials show natural aging and wear patterns.`
    ],
    manuscripts: [
      `Handwritten manuscript from ${1700 + num}. Calligraphic text in historic script. Parchment material.`,
      `Medieval document with illuminated letters. Ink shows aging but remains legible.`,
      `Personal journal entry dated ${1820 + num}. Cursive handwriting, some water staining.`
    ],
    posters: [
      `Vintage poster from ${1920 + num}. Bold typography and period-appropriate graphics.`,
      `Advertising poster with text overlay. Colors show fading consistent with age.`,
      `Informational poster displaying historical event announcements and details.`
    ],
    photographs: [
      `Historical photograph from ${1890 + num}. Black and white, shows period clothing and architecture.`,
      `Portrait photograph, professional studio quality. Mounted on card stock backing.`,
      `Documentary photograph capturing historical moment. Some edge wear visible.`
    ],
    paintings: [
      `Oil painting from ${1800 + num}. Canvas shows age-appropriate craquelure pattern.`,
      `Watercolor artwork depicting historical scene. Colors well-preserved under glass.`,
      `Portrait painting, period costume and background. Original gilt frame.`
    ],
    sculptures: [
      `Three-dimensional sculptural piece. Materials include stone/metal. Height: ~30cm.`,
      `Carved figurine showing fine detail work. Surface patina indicates age.`,
      `Decorative sculpture from ${1700 + num}. Shows craftsmanship of the period.`
    ],
    exhibits: [
      `Museum exhibit piece from collection. Educational display with informational placard.`,
      `Gallery display item showing historical significance. Professionally curated.`,
      `Featured exhibit from permanent collection. Conservation work completed.`
    ]
  };

  const categoryTemplates = templates[category] || templates.exhibits;
  return categoryTemplates[num % categoryTemplates.length];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run it
const outputDirectory = path.join(process.cwd(), 'smithsonian-test-images');
const imageCount = parseInt(process.argv[2]) || 500;

console.log('🏛️  Museum Test Image Downloader');
console.log(`Using Lorem Picsum for ${imageCount} diverse test images\n`);

downloadTestImages(outputDirectory, imageCount)
  .then(() => {
    console.log('\n🎉 Ready for upload to Firebase!');
    console.log('\nNext step:');
    console.log('  npm run upload YOUR_USER_ID');
  })
  .catch(error => {
    console.error('\n❌ Error:', error);
    process.exit(1);
  });

