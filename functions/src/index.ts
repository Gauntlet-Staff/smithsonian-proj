/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import {setGlobalOptions} from "firebase-functions";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {defineSecret} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import OpenAI from "openai";

// Define the secret
const openaiApiKey = defineSecret("OPENAI_API_KEY");

// Initialize Firebase Admin
admin.initializeApp();

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({maxInstances: 10});

/**
 * Cloud Function triggered when a new image document is created in Firestore
 * Automatically extracts text from the image using GPT-4 Vision
 */
export const imageTextExtraction = onDocumentCreated(
  {
    document: "images/{imageId}",
    region: "us-central1",
    secrets: [openaiApiKey],
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      logger.error("No data associated with the event");
      return;
    }

    const data = snapshot.data();
    const imageId = event.params.imageId;

    logger.info(`Processing image ${imageId}`, {imageId, fileName: data.fileName});

    // Skip if already processed or processing
    if (data.status !== "pending") {
      logger.info(`Image ${imageId} already processed or processing`);
      return;
    }

    const imageUrl = data.imageUrl;
    const userId = data.userId;

    if (!imageUrl || !userId) {
      logger.error("Missing required fields", {imageId, imageUrl, userId});
      await snapshot.ref.update({
        status: "failed",
        error: "Missing required fields",
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    try {
      // Update status to processing
      await snapshot.ref.update({
        status: "processing",
      });

      // Initialize OpenAI with API key from secret
      const openai = new OpenAI({
        apiKey: openaiApiKey.value(),
      });

      // Download image from Storage
      const bucket = admin.storage().bucket();
      const fileName = imageUrl.split("/").pop()?.split("?")[0];
      const decodedFileName = decodeURIComponent(fileName || "");

      // Extract path from URL (remove the base storage URL)
      const storagePath = decodedFileName.replace(
        `${bucket.name}/`,
        ""
      );

      logger.info(`Downloading image from ${storagePath}`);

      // Get image data
      const file = bucket.file(storagePath);
      const [fileBuffer] = await file.download();

      // Convert to base64
      const base64Image = fileBuffer.toString("base64");

      // Determine MIME type
      let mimeType = "image/jpeg";
      if (data.fileName.toLowerCase().endsWith(".png")) {
        mimeType = "image/png";
      } else if (data.fileName.toLowerCase().endsWith(".webp")) {
        mimeType = "image/webp";
      } else if (data.fileName.toLowerCase().endsWith(".heic") ||
                 data.fileName.toLowerCase().endsWith(".heif")) {
        mimeType = "image/jpeg"; // HEIC is converted to JPEG
      }

      logger.info("Calling OpenAI GPT-4 Vision API for text extraction");

      // Call OpenAI GPT-4 Vision
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                },
              },
              {
                type: "text",
                text: `Extract all visible text from this image. Include:
- Any printed text
- Handwritten text (if legible)
- Text on labels, signs, or documents
- Numbers and dates

Return ONLY the extracted text, maintaining the original layout and structure as much as possible. If there is no text in the image, respond with "No text detected".`,
              },
            ],
          },
        ],
        max_tokens: 1000,
      });

      const extractedText = response.choices[0]?.message?.content || "No text detected";

      logger.info(`Text extraction successful for ${imageId}`, {
        textLength: extractedText.length,
      });

      // Update Firestore with extracted text
      await snapshot.ref.update({
        extractedText: extractedText.trim(),
        status: "completed",
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: admin.firestore.FieldValue.delete(),
      });

      logger.info(`Successfully processed image ${imageId}`);
    } catch (error: unknown) {
      const err = error as Error;
      logger.error(`Error processing image ${imageId}:`, err);

      await snapshot.ref.update({
        status: "failed",
        error: err.message || "Unknown error occurred",
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
);

/**
 * Callable function to manually trigger text extraction for an image
 * Useful for retrying failed extractions
 */
export const retryTextExtraction = onCall(
  {region: "us-central1"},
  async (request) => {
    const {imageId} = request.data;

    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    if (!imageId) {
      throw new HttpsError("invalid-argument", "imageId is required");
    }

    const userId = request.auth.uid;

    try {
      const imageDoc = await admin
        .firestore()
        .collection("images")
        .doc(imageId)
        .get();

      if (!imageDoc.exists) {
        throw new HttpsError("not-found", "Image not found");
      }

      const imageData = imageDoc.data();

      if (imageData?.userId !== userId) {
        throw new HttpsError("permission-denied", "Not authorized to access this image");
      }

      // Reset status to pending to trigger the function
      await imageDoc.ref.update({
        status: "pending",
        error: admin.firestore.FieldValue.delete(),
      });

      return {success: true, message: "Text extraction retry triggered"};
    } catch (error: unknown) {
      const err = error as Error;
      logger.error("Error retrying text extraction:", err);
      throw new HttpsError("internal", err.message || "Failed to retry text extraction");
    }
  }
);

// Helper function: Sleep/delay
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function: Normalize report formatting
function normalizeReportFormatting(report: string): string {
  return report
    // Standardize "Exhibit #X" to "**EXHIBIT X**" (all caps, remove #, add bold)
    .replace(/\*{0,2}Exhibit\s*#?\s*(\d+)\*{0,2}/gi, "**EXHIBIT $1**")
    // Split sub-headers that are on the same line (e.g., "Date: text Significance: text")
    .replace(/\*{0,2}(Date|Significance|Materials|Condition|Recommendations):\*{0,2}\s*([^\n]+?)\s+\*{0,2}(Title|Date|Significance|Materials|Condition|Recommendations):/gi,
      "**$1:** $2\n\n**$3:")
    // Remove numbered list prefixes from section headers (1., 2., 3., etc.) - with or without colon
    .replace(/^\s*\d+\.\s+(Historical Significance:?|Physical Condition:?|Preservation:?)/gmi, "$1")
    // Remove bullet point prefixes from section headers (•, -, *, etc.) - with or without colon
    .replace(/^\s*[•\-*]\s+(Historical Significance:?|Physical Condition:?|Preservation:?)/gmi, "$1")
    // Ensure consistent format: no colons after section headers
    .replace(/^(Historical Significance|Physical Condition|Preservation):\s*/gmi, "$1\n\n")
    // Also catch colons in the middle of lines
    .replace(/(Historical Significance|Physical Condition|Preservation):\s*/gi, "$1\n\n");
}

// Helper function: Save report (to Storage if large, Firestore if small)
async function saveReport(
  reportText: string,
  reportId: string,
  bucket: any
): Promise<{reportUrl?: string; report?: string}> {
  const reportSizeBytes = Buffer.byteLength(reportText, "utf8");
  const MAX_FIRESTORE_SIZE = 900 * 1024; // 900 KB (safe threshold below 1 MB limit)

  logger.info(`Report size: ${reportSizeBytes} bytes (${(reportSizeBytes / 1024).toFixed(2)} KB)`);

  if (reportSizeBytes > MAX_FIRESTORE_SIZE) {
    // Large report - upload to Storage
    logger.info("Report exceeds Firestore limit, uploading to Storage");
    
    const fileName = `reports/${reportId}.txt`;
    const file = bucket.file(fileName);
    
    await file.save(reportText, {
      contentType: "text/plain; charset=utf-8",
      metadata: {
        metadata: {
          generatedAt: new Date().toISOString(),
        },
      },
    });

    // Make file publicly readable (only for authenticated users via security rules)
    await file.makePublic();
    
    // Get public URL
    const reportUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    logger.info(`Report uploaded to Storage: ${reportUrl}`);
    
    return {reportUrl};
  } else {
    // Small report - save directly to Firestore
    logger.info("Report fits in Firestore, saving directly");
    return {report: reportText};
  }
}

// Helper function: Process a single batch of images
async function processBatch(
  batch: Array<{
    imageUrl: string;
    fileName: string;
    extractedText: string;
    index: number;
  }>,
  batchIndex: number,
  prompt: string,
  reportStyle: string,
  reportDepth: string,
  openai: OpenAI,
  bucket: any
): Promise<{batchIndex: number; report: string; success: boolean; error?: string}> {
  try {
    logger.info(`Processing batch ${batchIndex + 1}`, {
      batchSize: batch.length,
      startIndex: batch[0].index,
      endIndex: batch[batch.length - 1].index,
    });

    // Download images and convert to base64
    const imageContents: Array<{type: "image_url"; image_url: {url: string}}> = [];
    const batchTexts: string[] = [];

    for (const img of batch) {
      try {
        // Extract storage path from URL
        const fileName = img.imageUrl.split("/").pop()?.split("?")[0];
        const decodedFileName = decodeURIComponent(fileName || "");
        const storagePath = decodedFileName.replace(`${bucket.name}/`, "");

        // Download image
        const file = bucket.file(storagePath);
        const [fileBuffer] = await file.download();
        const base64Image = fileBuffer.toString("base64");

        // Determine MIME type
        let mimeType = "image/jpeg";
        if (img.fileName.toLowerCase().endsWith(".png")) {
          mimeType = "image/png";
        } else if (img.fileName.toLowerCase().endsWith(".webp")) {
          mimeType = "image/webp";
        }

        imageContents.push({
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${base64Image}`,
          },
        });

        batchTexts.push(`[Image ${img.index + 1}]: ${img.extractedText}`);
      } catch (error) {
        logger.error(`Failed to download image ${img.fileName}:`, error);
      }
    }

    // System prompt for batch processing with STRICT template
    const depthGuidance = {
      brief: "Be concise and focus on key findings.",
      standard: "Provide balanced analysis with important details.",
      comprehensive: "Be thorough and detailed in your analysis.",
    };

    const styleGuidance = {
      casual: "Use a friendly, conversational tone. Write as if explaining to a curious visitor.",
      professional: "Use clear, professional museum language. Be informative and authoritative.",
      academic: "Use formal, scholarly language. Include technical terminology and detailed analysis.",
    };

    const systemPrompt = `You are analyzing museum exhibits. Follow the user's custom instructions for WHAT to analyze, but maintain consistent formatting.

TONE: ${styleGuidance[reportStyle as keyof typeof styleGuidance] || styleGuidance.professional}

FORMATTING STRUCTURE (use this as your template):
---
**EXHIBIT [NUMBER]** (all caps, bold)

**Title:** [object name]

**[Section Name]**

**Sub-heading:** [content]
**Sub-heading:** [content]

**[Section Name]**

**Sub-heading:** [content]
**Sub-heading:** [content]
---

EXAMPLE FORMAT for sections (you can adapt sections based on user's instructions):

**Historical Significance**
**Date:** ...
**Significance:** ...

**Physical Condition**
**Materials:** ...
**Condition:** ...

**Preservation**
**Recommendations:** ...

CRITICAL RULES:
- **EXHIBIT [NUMBER]** must be ALL CAPS and bold
- Use **bold** for ALL section headers and sub-headers
- Each sub-heading on its OWN line
- NO numbering (1., 2., 3.) before headings
- ${depthGuidance[reportDepth as keyof typeof depthGuidance] || depthGuidance.standard}

Now follow the user's specific analysis instructions below.`;

    // Build message content
    const userContent: Array<
      {type: "image_url"; image_url: {url: string}} |
      {type: "text"; text: string}
    > = [
      ...imageContents,
      {
        type: "text",
        text: `USER'S ANALYSIS INSTRUCTIONS:\n${prompt}\n\nAnalyze these ${batch.length} physical museum exhibits in ORDER based on the instructions above.\n\nExtracted text from images:\n${batchTexts.join("\n\n")}\n\nGenerate report for exhibits ${batch[0].index + 1} to ${batch[batch.length - 1].index + 1}.`,
      },
    ];

    // Call GPT-4o Vision
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      max_tokens: 4000,
      temperature: 0.7,
    });

    const report = response.choices[0]?.message?.content || "";

    logger.info(`Batch ${batchIndex + 1} completed successfully`);

    return {
      batchIndex,
      report,
      success: true,
    };
  } catch (error: unknown) {
    const err = error as Error;
    logger.error(`Batch ${batchIndex + 1} failed:`, err);
    return {
      batchIndex,
      report: "",
      success: false,
      error: err.message,
    };
  }
}

/**
 * Cloud Function triggered when a new report document is created in Firestore
 * Automatically generates comprehensive reports from multiple images using GPT-4
 * Uses parallel batch processing for large image sets (500+ images)
 */
export const generateReport = onDocumentCreated(
  {
    document: "reports/{reportId}",
    region: "us-central1",
    secrets: [openaiApiKey],
    timeoutSeconds: 540, // 9 minutes (max for Cloud Functions)
    memory: "1GiB",
    minInstances: 0, // Force redeploy - Storage support added
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      logger.error("No data associated with the event");
      return;
    }

    const data = snapshot.data();
    const reportId = event.params.reportId;

    logger.info(`Generating report ${reportId}`);

    // Skip if already processed or processing
    if (data.status !== "pending") {
      logger.info(`Report ${reportId} already processed or processing`);
      return;
    }

    const {imageIds, prompt, userId, reportStyle, reportDepth} = data;

    // Validate inputs
    if (!imageIds || !prompt || !userId || !Array.isArray(imageIds) || imageIds.length === 0) {
      logger.error("Missing required fields", {reportId, prompt, userId, hasImageIds: !!imageIds, imageIdsLength: imageIds?.length});
      await snapshot.ref.update({
        status: "failed",
        error: "Missing required fields or image data",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    const imageCount = imageIds.length;

    // Fetch image data from Firestore
    logger.info(`Fetching data for ${imageCount} images from Firestore`);
    const imageDataPromises = imageIds.map(async (imageId: string, index: number) => {
      const imageDoc = await admin.firestore().collection("images").doc(imageId).get();
      const imageData = imageDoc.data();
      if (!imageData) {
        logger.warn(`Image ${imageId} not found in Firestore`);
        return null;
      }
      return {
        fileName: imageData.fileName,
        imageUrl: imageData.imageUrl,
        extractedText: imageData.extractedText || "No text extracted",
        index: index, // Preserve sequence order
      };
    });

    const imageDataResults = await Promise.all(imageDataPromises);
    const imageData = imageDataResults.filter(img => img !== null) as Array<{fileName: string; imageUrl: string; extractedText: string; index: number}>;

    if (imageData.length === 0) {
      logger.error("No valid images found");
      await snapshot.ref.update({
        status: "failed",
        error: "No valid images found",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    // Build combined texts from fetched image data
    const combinedTexts = imageData.map((img, index) =>
      `--- ${img.fileName} ---\n${img.extractedText}\n`
    ).join("\n");

    const BATCH_THRESHOLD = 20; // Use batch processing for > 20 images

    try {
      // Update status to processing
      await snapshot.ref.update({
        status: "processing",
        progress: {
          stage: "initializing",
          completed: 0,
          total: imageCount,
          message: `Preparing to process ${imageCount} images...`,
        },
      });

      logger.info("Generating report with vision analysis", {
        textLength: combinedTexts.length,
        promptLength: prompt.length,
        reportStyle: reportStyle || "professional",
        reportDepth: reportDepth || "standard",
        imageCount: imageCount,
        batchMode: imageCount > BATCH_THRESHOLD,
      });

      // Initialize OpenAI
      const openai = new OpenAI({
        apiKey: openaiApiKey.value(),
      });

      const bucket = admin.storage().bucket();

      // Decision: Batch processing or single request?
      if (imageCount > BATCH_THRESHOLD) {
        // PARALLEL BATCH PROCESSING for large datasets
        logger.info(`Using parallel batch processing for ${imageCount} images`);

        // Dynamic batch sizing based on total images
        let imagesPerBatch = 5;
        if (imageCount > 200) {
          imagesPerBatch = 5; // 500 images = 100 batches
        } else if (imageCount > 100) {
          imagesPerBatch = 10; // 200 images = 20 batches
        } else if (imageCount > 50) {
          imagesPerBatch = 10; // 100 images = 10 batches
        }

        const batches: Array<typeof imageData> = [];
        for (let i = 0; i < imageCount; i += imagesPerBatch) {
          const batchData = imageData.slice(i, i + imagesPerBatch).map((img, idx) => ({
            ...img,
            index: i + idx, // Preserve sequence order
          }));
          batches.push(batchData);
        }

        logger.info(`Created ${batches.length} batches of ~${imagesPerBatch} images each`);

        await snapshot.ref.update({
          progress: {
            imagesProcessed: 0,
            totalImages: imageCount,
            message: `Starting to process ${imageCount} images...`,
          },
        });

        // Process batches in parallel - MAXIMUM SPEED
        const CONCURRENT_BATCHES = 30; // Process 30 batches at a time for speed
        const batchResults: Array<{batchIndex: number; report: string; success: boolean; error?: string}> = [];

        for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
          const batchGroup = batches.slice(i, i + CONCURRENT_BATCHES);

          logger.info(`Processing batch group ${Math.floor(i / CONCURRENT_BATCHES) + 1} of ${Math.ceil(batches.length / CONCURRENT_BATCHES)}`);

          // Process batches in parallel
          const promises = batchGroup.map((batch, idx) =>
            processBatch(
              batch,
              i + idx,
              prompt,
              reportStyle || "professional",
              reportDepth || "standard",
              openai,
              bucket
            )
          );

          const results = await Promise.all(promises);
          batchResults.push(...results);

          // Calculate images processed from successful batches
          const imagesProcessed = batchResults.filter(r => r.success).reduce((sum, r) => {
            const batch = batches[r.batchIndex];
            return sum + batch.length;
          }, 0);

          // Update progress with images processed
          await snapshot.ref.update({
            progress: {
              imagesProcessed,
              totalImages: imageCount,
              message: `Processing ${imagesProcessed} out of ${imageCount} images...`,
            },
          });

          // No delays - maximum speed!
        }

        // Check for failures
        const failedBatches = batchResults.filter((r) => !r.success);
        if (failedBatches.length > 0) {
          logger.warn(`${failedBatches.length} batches failed, attempting retry...`);

          const successfulImages = batchResults.filter(r => r.success).reduce((sum, r) => {
            const batch = batches[r.batchIndex];
            return sum + batch.length;
          }, 0);

          await snapshot.ref.update({
            progress: {
              imagesProcessed: successfulImages,
              totalImages: imageCount,
              message: `Retrying some images... (${successfulImages} processed so far)`,
            },
          });

          // Retry failed batches with smaller size
          for (const failed of failedBatches) {
            const originalBatch = batches[failed.batchIndex];
            // Split into smaller batches (2 images each)
            const smallBatches: Array<typeof originalBatch> = [];
            for (let j = 0; j < originalBatch.length; j += 2) {
              smallBatches.push(originalBatch.slice(j, j + 2));
            }

            logger.info(`Retrying batch ${failed.batchIndex + 1} with ${smallBatches.length} smaller batches`);

            for (let k = 0; k < smallBatches.length; k++) {
              const retryResult = await processBatch(
                smallBatches[k],
                failed.batchIndex,
                prompt,
                reportStyle || "professional",
                reportDepth || "standard",
                openai,
                bucket
              );

              if (retryResult.success) {
                // Update the failed result with success
                failed.success = true;
                failed.report += retryResult.report + "\n\n";
              }

              await sleep(1000); // Rate limiting
            }
          }
        }

        // Aggregate results in order
        await snapshot.ref.update({
          progress: {
            imagesProcessed: imageCount,
            totalImages: imageCount,
            message: "Finalizing your report...",
          },
        });

        batchResults.sort((a, b) => a.batchIndex - b.batchIndex);
        const successfulResults = batchResults.filter((r) => r.success);

        // Combine mini-reports into final report
        const rawReport = `# Museum Collection Analysis\n\n**Total Exhibits Analyzed:** ${imageCount}\n**Processing Method:** Parallel Batch Processing\n**Batches Processed:** ${batches.length}\n**Report Style:** ${reportStyle || "Professional"}\n**Depth:** ${reportDepth || "Standard"}\n\n---\n\n${successfulResults.map((r) => r.report).join("\n\n---\n\n")}`;

        // Normalize formatting to ensure consistency across all batches
        const finalReport = normalizeReportFormatting(rawReport);

        logger.info("Batch processing completed", {
          totalBatches: batches.length,
          successfulBatches: successfulResults.length,
          failedBatches: failedBatches.length,
          reportLength: finalReport.length,
        });

        // Save report (to Storage if large, Firestore if small)
        const savedReport = await saveReport(finalReport, reportId, bucket);

        // Update Firestore with final report
        await snapshot.ref.update({
          ...savedReport,
          status: "completed",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          batchMetrics: {
            totalBatches: batches.length,
            successfulBatches: successfulResults.length,
            failedBatches: failedBatches.length,
            imagesPerBatch: imagesPerBatch,
          },
          error: admin.firestore.FieldValue.delete(),
          progress: admin.firestore.FieldValue.delete(),
        });

        logger.info(`Successfully generated batched report ${reportId}`);
      } else {
        // SINGLE REQUEST for small datasets (< 20 images)
        logger.info(`Using single request for ${imageCount} images`);

        await snapshot.ref.update({
          progress: {
            imagesProcessed: 0,
            totalImages: imageCount,
            message: `Processing ${imageCount} images...`,
          },
        });

        const imageContents: Array<{type: "image_url"; image_url: {url: string}}> = [];

        for (const img of imageData) {
          try {
            // Extract storage path from URL
            const fileName = img.imageUrl.split("/").pop()?.split("?")[0];
            const decodedFileName = decodeURIComponent(fileName || "");
            const storagePath = decodedFileName.replace(`${bucket.name}/`, "");

            // Download image
            const file = bucket.file(storagePath);
            const [fileBuffer] = await file.download();
            const base64Image = fileBuffer.toString("base64");

            // Determine MIME type
            let mimeType = "image/jpeg";
            if (img.fileName.toLowerCase().endsWith(".png")) {
              mimeType = "image/png";
            } else if (img.fileName.toLowerCase().endsWith(".webp")) {
              mimeType = "image/webp";
            }

            imageContents.push({
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
              },
            });
          } catch (error) {
            logger.error(`Failed to download image ${img.fileName}:`, error);
          }
        }

        // System prompt with STRICT template (same as batch processing)
        const depthGuidance = {
          brief: "Be concise and focus on key findings.",
          standard: "Provide balanced analysis with important details.",
          comprehensive: "Be thorough and detailed in your analysis.",
        };

        const styleGuidance = {
          casual: "Use a friendly, conversational tone. Write as if explaining to a curious visitor.",
          professional: "Use clear, professional museum language. Be informative and authoritative.",
          academic: "Use formal, scholarly language. Include technical terminology and detailed analysis.",
        };

        const systemPrompt = `You are analyzing museum exhibits. Follow the user's custom instructions for WHAT to analyze, but maintain consistent formatting.

TONE: ${styleGuidance[reportStyle as keyof typeof styleGuidance] || styleGuidance.professional}

FORMATTING STRUCTURE (use this as your template):
---
**EXHIBIT [NUMBER]** (all caps, bold)

**Title:** [object name]

**[Section Name]**

**Sub-heading:** [content]
**Sub-heading:** [content]

**[Section Name]**

**Sub-heading:** [content]
**Sub-heading:** [content]
---

EXAMPLE FORMAT (you can adapt sections based on user's instructions):
**Historical Significance**
**Title:** ...
**Date:** ...
**Significance:** ...

**Physical Condition**
**Materials:** ...
**Condition:** ...

**Preservation**
**Recommendations:** ...

CRITICAL RULES:
- **EXHIBIT [NUMBER]** must be ALL CAPS and bold
- Use **bold** for ALL section headers and sub-headers
- Each sub-heading on its OWN line
- NO numbering (1., 2., 3.) before headings
- ${depthGuidance[reportDepth as keyof typeof depthGuidance] || depthGuidance.standard}

Now follow the user's specific analysis instructions below.`;

        // Build message content with images and text
        const userContent: Array<
          {type: "image_url"; image_url: {url: string}} |
          {type: "text"; text: string}
        > = [
          ...imageContents,
          {
            type: "text",
            text: `USER'S ANALYSIS INSTRUCTIONS:\n${prompt}\n\nYou are viewing PHOTOGRAPHS of physical museum exhibits. Analyze the ACTUAL objects you see in these images based on the instructions above.\n\nExtracted text from images:\n\n${combinedTexts}\n\nUse this text along with your VISUAL analysis to generate your report in markdown format.`,
          },
        ];

        // Call GPT-4o Vision to generate comprehensive report
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: userContent,
            },
          ],
          max_tokens: 16000, // High limit - let depth guide the length
          temperature: 0.7,
        });

        const rawReport = response.choices[0]?.message?.content || "Failed to generate report";

        // Normalize formatting to ensure consistency
        const report = normalizeReportFormatting(rawReport);

        logger.info("Report generated successfully", {
          reportLength: report.length,
        });

        // Save report (to Storage if large, Firestore if small)
        const savedReport = await saveReport(report, reportId, bucket);

        // Update Firestore with generated report
        await snapshot.ref.update({
          ...savedReport,
          status: "completed",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          error: admin.firestore.FieldValue.delete(),
        });

        logger.info(`Successfully generated report ${reportId}`);
      }
    } catch (error: unknown) {
      const err = error as Error;
      logger.error(`Error generating report ${reportId}:`, err);

      await snapshot.ref.update({
        status: "failed",
        error: err.message || "Unknown error occurred",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
);
