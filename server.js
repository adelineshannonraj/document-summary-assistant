require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');
const { GoogleGenAI } = require('@google/genai');
const { PDFParse } = require('pdf-parse');
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});
console.log(
    'Gemini API key loaded:',
    !!process.env.GEMINI_API_KEY
);
const { createWorker } = require('tesseract.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Safety net: never let one bad request (e.g. an OCR worker network hiccup)
// take the whole server down.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store uploads temporarily on disk (use system temp dir for serverless environments)
const tmpDir = os.tmpdir();
const upload = multer({
  dest: tmpDir,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    // Accept common MIME variants; some OSes/browsers report legacy types like image/x-png or image/pjpeg.
    const allowed = ['application/pdf', 'image/png', 'image/x-png', 'image/jpeg', 'image/pjpeg', 'image/jpg', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type. Please upload a PDF or image (png/jpg/webp).'));
  }
});

// ---------- Text extraction helpers ----------

async function extractFromPDF(filePath) {
  let parser;

  try {
    const buffer = fs.readFileSync(filePath);

    parser = new PDFParse({
      data: new Uint8Array(buffer)
    });

    const result = await parser.getText();

    const text = result.text ? result.text.trim() : '';

    if (!text) {
      throw new Error(
        'No readable text found in this PDF. It may be a scanned PDF.'
      );
    }

    return text;

  } catch (err) {
    console.error(
      'PDF extraction error:',
      err && (err.stack || err.message)
        ? (err.stack || err.message)
        : err
    );

    throw new Error('Failed to extract text from PDF.');

  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch (destroyError) {
        console.warn(
          'Failed to destroy PDF parser:',
          destroyError.message
        );
      }
    }
  }
}

async function preprocessImage(filePath) {
  const out = filePath + '.proc.png';
  try {
    await sharp(filePath)
      .grayscale()
      .resize({ width: 1600 })
      .normalize()
      .sharpen()
      .toFile(out);
    return out;
  } catch (err) {
    console.warn('Image preprocessing failed, falling back to original file:', err && err.message ? err.message : err);
    return filePath;
  }
}

function isReadableText(text) {
  if (!text) return false;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const alphaChars = (text.match(/[A-Za-z]/g) || []).length;
  const totalChars = Math.max(1, text.length);
  const alphaRatio = alphaChars / totalChars;
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / Math.max(1, wordCount);
  if (wordCount < 3) return false;
  if (alphaRatio < 0.35) return false;
  if (avgWordLen < 3) return false;
  return true;
}

async function extractFromImage(filePath) {
  let worker;
  let processedPath = null;
  try {
    worker = await createWorker();

    const methodKeys = Object.keys(worker).filter(k => typeof worker[k] === 'function');
    console.log('Tesseract worker methods:', methodKeys);

    if (typeof worker.load === 'function' && typeof worker.loadLanguage === 'function' && typeof worker.initialize === 'function') {
      await worker.load();
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
    } else if (typeof worker.initialize === 'function') {
      try {
        await worker.initialize('eng');
      } catch (e) {
        await worker.initialize();
      }
    } else {
      console.warn('Tesseract worker appears to use a different API; attempting to run recognize without explicit init.');
    }

    if (typeof worker.recognize !== 'function') {
      throw new Error('Tesseract worker does not provide a recognize() method.');
    }

    // Preprocess the image to improve OCR on photos
    processedPath = await preprocessImage(filePath);

    const { data: { text } } = await worker.recognize(processedPath);
    const cleaned = (text || '').trim();

    if (!isReadableText(cleaned)) {
      console.warn('OCR produced unreadable text; sample:', cleaned.slice(0, 200));
      throw new Error('No readable text found in the image. Try cropping to the text region or using a clearer scan/photo.');
    }

    return cleaned;
  } catch (err) {
    console.error('Tesseract recognition error:', err);
    throw new Error(err.message || 'OCR engine failed to process this image. Please try a different file.');
  } finally {
    try {
      if (processedPath && processedPath !== filePath && fs.existsSync(processedPath)) {
        fs.unlink(processedPath, () => {});
      }
    } catch (e) {
      console.warn('Failed to cleanup processed image:', e);
    }

    try {
      if (worker && typeof worker.terminate === 'function') {
        await worker.terminate();
      } else if (worker && worker.worker && typeof worker.worker.terminate === 'function') {
        await worker.worker.terminate();
      } else if (worker) {
        console.warn('Tesseract worker has no terminate() method; worker keys:', Object.keys(worker));
      }
    } catch (terminateErr) {
      console.error('Error while terminating tesseract worker:', terminateErr);
    }
  }
}

// ---------- Extractive summarization (no external API needed) ----------
// Word-frequency scored sentence extraction — a classic, dependable
// approach (similar to Luhn's algorithm) that needs no API key.

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','of','at','by','for','with','about',
  'against','between','into','through','during','before','after','above',
  'below','to','from','up','down','in','out','on','off','over','under',
  'again','further','then','once','is','are','was','were','be','been',
  'being','have','has','had','having','do','does','did','doing','this',
  'that','these','those','it','its','as','not','so','than','too','very',
  'can','will','just','should','now','also','which','who','whom'
]);

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
}

function scoreSentences(text) {
  const sentences = splitSentences(text).map(s => s.trim()).filter(s => s.length > 0);
  const wordFreq = {};

  sentences.forEach(sentence => {
    const words = sentence.toLowerCase().match(/[a-z']+/g) || [];
    words.forEach(w => {
      if (!STOPWORDS.has(w) && w.length > 2) {
        wordFreq[w] = (wordFreq[w] || 0) + 1;
      }
    });
  });

  const maxFreq = Math.max(...Object.values(wordFreq), 1);
  Object.keys(wordFreq).forEach(w => (wordFreq[w] /= maxFreq));

  const scored = sentences.map((sentence, idx) => {
    const words = sentence.toLowerCase().match(/[a-z']+/g) || [];
    let score = 0;
    words.forEach(w => { if (wordFreq[w]) score += wordFreq[w]; });
    // Slight boost for earlier sentences (titles/intros often carry more weight)
    const positionBoost = idx === 0 ? 1.2 : 1;
    return { sentence, score: (score / Math.max(words.length, 1)) * positionBoost, idx };
  });

  return scored;
}

function summarize(text, length = 'medium') {
  const scored = scoreSentences(text);
  if (scored.length === 0) return { summary: '', keyPoints: [] };

  const ratios = { short: 0.15, medium: 0.3, long: 0.5 };
  const ratio = ratios[length] || ratios.medium;
  const count = Math.max(2, Math.round(scored.length * ratio));

  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, count);
  const ordered = top.sort((a, b) => a.idx - b.idx);

  const summary = ordered.map(s => s.sentence.trim()).join(' ');
  const keyPoints = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .sort((a, b) => a.idx - b.idx)
    .map(s => s.sentence.trim());

  return { summary, keyPoints };
}
// -----------LLM--------------------------
async function generateAISummary(text, length = 'medium') {
  const instructions = {
    short: `
Create a concise summary in 3-5 sentences.
Include only the most important information.
`,
    medium: `
Create a clear summary in 1-2 paragraphs.
Cover the main ideas and important supporting details.
`,
    long: `
Create a detailed summary.
Cover all major ideas, important facts, and conclusions.
Avoid unnecessary repetition.
`
  };

  const prompt = `
You are a professional document summarization assistant.

Summarize the document below.

${instructions[length] || instructions.medium}

Rules:
- Use ONLY information contained in the document.
- Do not invent facts.
- Preserve important names, numbers, dates, and technical terms.
- Make the summary clear and easy to understand.
- Also identify exactly 5 important key points.

Return ONLY this format:

SUMMARY:
<summary>

KEY POINTS:
- <point 1>
- <point 2>
- <point 3>
- <point 4>
- <point 5>

DOCUMENT:
${text}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt
  });

  const output = response.text;

  if (!output) {
    throw new Error('AI did not return a summary.');
  }

  return parseAISummary(output);
}
async function generateImageSummary(imagePath, mimeType, length = 'medium') {

  const imageData = fs.readFileSync(imagePath).toString('base64');

  const instructions = {
    short: `
Give a concise 2-3 sentence description of the image.
Focus on the main subject and most important visible details.
`,
    medium: `
Give a clear 1-2 paragraph description of the image.
Describe the main subject, setting, important objects, and notable visual details.
`,
    long: `
Give a detailed description of the image.
Cover the main subject, setting, objects, composition, colors, and other important visible details.
`
  };

  const prompt = `
You are an intelligent image understanding and summarization assistant.

Analyze the image carefully.

${instructions[length] || instructions.medium}

IMPORTANT RULES:
- Describe ONLY what can reasonably be observed in the image.
- Do not invent objects, people, locations, or events.
- If there is visible text, you may mention important text.
- Focus on useful visual information.
- Also provide exactly 5 key points.

Return ONLY this format:

SUMMARY:
<summary>

KEY POINTS:
- <point 1>
- <point 2>
- <point 3>
- <point 4>
- <point 5>
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: [
      {
        inlineData: {
          mimeType: mimeType,
          data: imageData
        }
      },
      {
        text: prompt
      }
    ]
  });

  const output = response.text;

  if (!output) {
    throw new Error('AI did not return an image summary.');
  }

  return parseAISummary(output);
}

function parseAISummary(output) {
  const summaryMatch = output.match(
    /SUMMARY:\s*([\s\S]*?)(?=\n\s*KEY POINTS:)/i
  );

  const keyPointsMatch = output.match(
    /KEY POINTS:\s*([\s\S]*)/i
  );

  const summary = summaryMatch
    ? summaryMatch[1].trim()
    : output.trim();

  const keyPoints = keyPointsMatch
    ? keyPointsMatch[1]
        .split('\n')
        .map(line => line.replace(/^[-•*]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  return {
    summary,
    keyPoints
  };
}
// ---------- Routes ----------

app.post('/api/process', upload.single('document'), async (req, res) => {
  const file = req.file;
  const length = req.body.length || 'medium';

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  // Ensure uploaded files are cleaned from the system temp directory after the response finishes
  res.on('finish', () => {
    try {
      if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (e) {
      // best-effort cleanup
    }
    try {
      const proc = file && file.path ? file.path + '.proc.png' : null;
      if (proc && fs.existsSync(proc)) fs.unlinkSync(proc);
    } catch (e) {}
  });

  try {
    let summary;
    let keyPoints;
    let text = '';

    // Detect PDFs by MIME type or filename extension to handle environments that report nonstandard MIME types
    const ext = path.extname(file.originalname || '').toLowerCase();
    const isPdf = (file.mimetype && file.mimetype.toLowerCase().includes('pdf')) || ext === '.pdf';

    if (isPdf) {

  // PDF → extract text → Gemini
    text = await extractFromPDF(file.path);

    if (!text || text.length < 20) {
      throw new Error(
        'Could not extract readable text from this PDF.'
      );
    }

    try {
      const aiResult = await generateAISummary(text, length);

      summary = aiResult.summary;
      keyPoints = aiResult.keyPoints;

    } catch (aiError) {
        console.error('AI PDF summarization failed:', aiError);

    // Fallback to existing extractive summarizer
        const fallback = summarize(text, length);

        summary = fallback.summary;
        keyPoints = fallback.keyPoints;
    }

  } else {

  // IMAGE -> try OCR (for word count/preview) then Gemini Vision
    try {
      // Attempt OCR to populate `text` used for wordCount and extractedTextPreview.
      // Do not fail the whole request if OCR fails; AI image summarization can still run.
      try {
        text = await extractFromImage(file.path);
      } catch (ocrErr) {
        console.warn('OCR for image failed or produced no readable text:', ocrErr && ocrErr.message ? ocrErr.message : ocrErr);
        text = '';
      }

      const aiResult = await generateImageSummary(
        file.path,
        file.mimetype,
        length
      );

      summary = aiResult.summary;
      keyPoints = aiResult.keyPoints;

    } catch (aiError) {
      console.error('AI image understanding failed:', aiError);
      // If OCR produced readable text, fallback to the extractive summarizer so the user still gets a text-based summary.
      if (text && text.length > 20) {
        console.log('Falling back to extractive summarizer for image text.');
        const fallback = summarize(text, length);
        summary = fallback.summary;
        keyPoints = fallback.keyPoints;
      } else {
        // Gemini failed and OCR produced no readable text. Provide a graceful fallback
        // response so the UI can show a helpful message instead of a generic error.
        console.warn('Gemini unavailable and no OCR text; returning graceful fallback summary.');
        summary = 'No readable text was extracted from the image and the AI service is currently unavailable. Try uploading a clearer scan or try again later.';
        keyPoints = [];
      }
    }
  }

    res.json({
      extractedTextPreview: text ? text.slice(0, 3000) : '',
      wordCount: text ? text.split(/\s+/).length : 0,
      summary,
      keyPoints,
      summaryLength: length
    });
  } catch (err) {
    if (file && fs.existsSync(file.path)) fs.unlink(file.path, () => {});
    console.error(err);
    if (err && err.message && err.message.includes('No readable text')) {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || 'Something went wrong while processing the document.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message.includes('Unsupported file type')) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Document Summary Assistant running on port ${PORT}`);
  });
}

module.exports = app;
