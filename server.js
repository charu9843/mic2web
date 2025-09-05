const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { OpenAI } = require('openai');
const archiver = require('archiver');
const { BlobServiceClient } = require('@azure/storage-blob');
const mime = require('mime-types');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;


// OpenAI API setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 120000
});

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/preview', express.static(path.join(__dirname, 'generated-site')));


// connect database

// Route 1: Understand intent from Tamil speech using GPT
app.post('/intent', async (req, res) => {
  const { tamilText } = req.body;

  if (!tamilText || tamilText.trim() === '') {
    return res.status(400).json({ success: false, error: 'Tamil text is required' });
  }

  try {
    const completion = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  temperature: 0.4,
  max_tokens: 500,
  messages: [
    { role: 'system', content: ' You are an assistant that understands Tamil and converts spoken Tamil into a detailed website intent in English. Always elaborate dynamically, include possible features, sections, and describe the purpose of the site in multiple sentences.' },
    { role: 'user', content: `Tamil Input: "${tamilText}". What kind of website does the user want?` }
  ],
});


    const intent = completion.choices[0].message.content.trim();
    console.log("📝 Tamil Text:", tamilText);
    console.log("🎯 Intent:", intent);

    res.json({ success: true, intent });

  } catch (error) {
    console.error('❌ GPT intent error:', error);
    res.status(500).json({ success: false, error: 'Failed to detect intent' });
  }
});

// Route 2: Generate website project code and save to /generated-site
app.post('/generate-code', async (req, res) => {
  const { intent } = req.body;

  if (!intent || intent.trim() === '') {
    return res.status(400).json({ success: false, error: 'Intent is required to generate code.' });
  }
  try {
  const completion = await openai.chat.completions.create({
  model: "gpt-4o", 
  temperature: 0.4,
  max_tokens: 3000,
  messages: [
    {
      role: "system",
      content: `
You are a coding assistant that generates complete, production-ready multi-file websites based on user intent.

Always:
- Produce professional, responsive HTML using Tailwind CSS via CDN (never use PostCSS or @import).
- Include:
  - index.html with multiple sections 
  - style.css for extra custom styles
  - script.js for interactivity (animations, smooth scroll, etc.)
  - server.js using Express to serve static files
  - package.json with correct dependencies and a start script
 
  - Each Image must have a unique static Unsplash image URL (https://images.unsplash.com/...) with parameters ?w=800&h=600&fit=crop
  - Include alt text for each image
  
  - Use Tailwind classes: object-cover rounded-lg mb-4 w-full h-64
  
  - Ensure all images are visible and evenly spaced
   **If a section (like Services, Products, or Team) contains multiple cards, each card must use a different static Unsplash CDN image URL (do not reuse the same one).**

 Fill sections with relevant sample content so the site feels complete.
- Keep filenames consistent with references in the code.
- Avoid React or build tools unless the user explicitly requests them.
- Each navbar link must be an anchor tag linking to a matching section ID on the page.
- Add smooth scrolling for anchor navigation using CSS or JavaScript.
- Keep filenames consistent with references in the code

Format the output EXACTLY as:
--- index.html ---
<code>
--- style.css ---
<code>
--- script.js ---
<code>
--- server.js ---
<code>
--- package.json ---
<code>

  `.trim(),
    },
    {
      role: "user",
      content: `Intent: ${intent}\n\nGenerate the full code as files (index.html, style.css, script.js, server.js, package.json).Follow the output format exactly.`
    }
  ],
});


  
    const gptOutput = completion.choices[0].message.content;
    console.log("📦 GPT Code Output:\n", gptOutput);

    // Parse files from GPT output
    const files = {};
    //const regex = /---\s*(.*?)\s*---\n([\s\S]*?)(?=(---|$))/g;
    const regex = /---\s*([\w.\-]+)\s*---\s*\n([\s\S]*?)(?=(---\s*[\w.\-]+\s*---|$))/g;

let match;
while ((match = regex.exec(gptOutput)) !== null) {
  const filename = match[1].trim();
  let content = match[2].trim();

  // ✅ Clean code block formatting if present
  if (content.startsWith("```")) {
    content = content.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  }

  files[filename] = content;
}


    // Save files to /generated-site
    const folderPath = path.join(__dirname, 'generated-site');
    await fsp.rm(folderPath, { recursive: true, force: true });
    await fsp.mkdir(folderPath);

    for (const [filename, content] of Object.entries(files)) {
      const filePath = path.join(folderPath, filename);
      await fsp.writeFile(filePath, content, 'utf-8');
    }

    res.json({ success: true, message: 'Code generated and saved', files: Object.keys(files) });

  } catch (error) {
    console.error('❌ Code generation error:',error);
    res.status(500).json({ success: false, error: 'Failed to generate project code' });
  }
});
app.get('/download', async (req, res) => {
  const folderPath = path.join(__dirname, 'generated-site');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename=generated-site.zip');

  const archive = archiver('zip', {
    zlib: { level: 9 } // Maximum compression
  });

  archive.on('error', err => {
    console.error('❌ Archive error:', err);
    res.status(500).send({ error: 'Could not create archive' });
  });

  archive.pipe(res);
  archive.directory(folderPath, false);

  await archive.finalize();
});

app.post('/save-edits', async (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ message: 'Filename and content required' });
  try {
    const filePath = path.join(__dirname, 'generated-site', filename);
    await fsp.writeFile(filePath, content, 'utf-8');
    res.json({ message: '✅ Edits saved successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '❌ Failed to save edits' });
  }
});

// DEPLOY ROUTE

app.post('/deploy', async (req, res) => {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING
    );

    const containerName = '$web';
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // 1. Ensure $web container exists
    if (!(await containerClient.exists())) {
      await blobServiceClient.createContainer(containerName, { access: 'container' });
    }

    // 2. Clear old deployment
    for await (const blob of containerClient.listBlobsFlat()) {
      await containerClient.deleteBlob(blob.name);
    }

    // 3. Upload all files from generated-site
    const siteDir = path.join(__dirname, 'generated-site');
    const files = await fsp.readdir(siteDir);

    for (const filename of files) {
      const filePath = path.join(siteDir, filename);
      const content = await fsp.readFile(filePath);
      const blockBlobClient = containerClient.getBlockBlobClient(filename);

      const contentType = mime.lookup(filename) || 'application/octet-stream';
      const cacheControl = filename === 'index.html' ? 'no-cache' : 'public, max-age=3600';

      await blockBlobClient.upload(content, content.length, {
        blobHTTPHeaders: {
          blobContentType: contentType,
          blobCacheControl: cacheControl
        },
        overwrite: true
      });
    }

    // 4. Return live site URL
    const liveUrl = process.env.STATIC_SITE_URL;
    res.json({ success: true, message: '✅ Website deployed successfully!', url: liveUrl });

  } catch (err) {
    console.error('❌ Deploy error:', err);
    res.status(500).json({ success: false, message: '❌ Failed to deploy site', error: err.message });
  }
});


app.listen(port, () => {
  console.log(`🚀 Server running at: http://localhost:${port}`);
});

