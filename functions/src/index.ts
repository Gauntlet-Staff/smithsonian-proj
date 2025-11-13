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

/**
 * Cloud Function triggered when a new report document is created in Firestore
 * Automatically generates comprehensive reports from multiple images using GPT-4
 */
export const generateReport = onDocumentCreated(
  {
    document: "reports/{reportId}",
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
    const reportId = event.params.reportId;

    logger.info(`Generating report ${reportId}`);

    // Skip if already processed or processing
    if (data.status !== "pending") {
      logger.info(`Report ${reportId} already processed or processing`);
      return;
    }

    const {combinedTexts, prompt, userId, reportStyle, maxTokens, imageData} = data;

    // Validate inputs
    if (!combinedTexts || !prompt || !userId || !imageData || !Array.isArray(imageData)) {
      logger.error("Missing required fields", {reportId, combinedTexts, prompt, userId, hasImageData: !!imageData});
      await snapshot.ref.update({
        status: "failed",
        error: "Missing required fields or image data",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    try {
      // Update status to processing
      await snapshot.ref.update({
        status: "processing",
      });

      logger.info("Generating report with vision analysis", {
        textLength: combinedTexts.length,
        promptLength: prompt.length,
        reportStyle: reportStyle || "professional",
        maxTokens: maxTokens || 1500,
        imageCount: imageData.length,
      });

      // Initialize OpenAI
      const openai = new OpenAI({
        apiKey: openaiApiKey.value(),
      });

      // Download images and convert to base64
      const bucket = admin.storage().bucket();
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

      // Adjust system prompt based on report style
      const stylePrompts = {
        casual: "You are a friendly museum guide analyzing PHYSICAL museum exhibits from photographs. You can SEE the actual artifacts, objects, and displays. Write in a conversational tone. Analyze what you SEE in the images: materials, condition, wear, damage, colors, etc.",
        professional: "You are a professional museum curator analyzing PHYSICAL museum exhibits from photographs. You can SEE the actual artifacts. Use your visual analysis to assess: Historical Significance, Physical Condition (materials, wear, deterioration), and Preservation Recommendations. Be specific about what you observe visually.",
        academic: "You are a scholarly museum researcher analyzing PHYSICAL museum exhibits from photographs. You can SEE the actual objects. Provide formal analysis of: materials, manufacturing techniques, condition assessment, deterioration patterns, and conservation requirements based on visual evidence.",
      };

      const systemPrompt = stylePrompts[reportStyle as keyof typeof stylePrompts] ||
        stylePrompts.professional;

      // Build message content with images and text
      const userContent: Array<
        {type: "image_url"; image_url: {url: string}} |
        {type: "text"; text: string}
      > = [
        ...imageContents,
        {
          type: "text",
          text: `${prompt}\n\nYou are viewing PHOTOGRAPHS of physical museum exhibits. Analyze the ACTUAL objects you see in these images.\n\nFor each exhibit, assess:\n1. **Historical Significance** - What is it? When is it from? Why is it important?\n2. **Physical Condition** - What materials do you see? What is the condition? Any damage, fading, wear?\n3. **Preservation Recommendations** - Based on what you observe, what conservation is needed?\n\nThe text has already been extracted from these images:\n\n${combinedTexts}\n\nUse this text along with your VISUAL analysis of the images to generate a comprehensive museum report.`,
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
        max_tokens: maxTokens || 1500,
        temperature: 0.7,
      });

      const report = response.choices[0]?.message?.content || "Failed to generate report";

      logger.info("Report generated successfully", {
        reportLength: report.length,
      });

      // Update Firestore with generated report
      await snapshot.ref.update({
        report: report,
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: admin.firestore.FieldValue.delete(),
      });

      logger.info(`Successfully generated report ${reportId}`);
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
