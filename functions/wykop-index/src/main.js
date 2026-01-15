import * as sdk from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { GoogleGenAI } from '@google/genai';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export default async ({ req, res, log, error }) => {
  try {
    // Initialize Appwrite client
    const client = new sdk.Client()
      .setEndpoint('https://fra.cloud.appwrite.io/v1')
      .setProject('wykopindex')
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new sdk.Databases(client);
    const storage = new sdk.Storage(client);

    // Initialize Gemini AI
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const model = 'gemini-3-flash-preview';
    const systemInstruction = `You are a helpful assistant that analyzes sentiment about stock markets on a Polish social media platform.
    Always respond with a valid JSON, don't include any additional characters or formatting around the JSON response.`;

    // Schema validation helper
    const validateSchema = (data, schema) => {
      const errors = [];
      for (const [key, type] of Object.entries(schema)) {
        if (!(key in data)) {
          errors.push(`Missing field: ${key}`);
        } else if (type === 'string' && typeof data[key] !== 'string') {
          errors.push(`Field ${key} should be string, got ${typeof data[key]}`);
        } else if (type === 'array' && !Array.isArray(data[key])) {
          errors.push(`Field ${key} should be array, got ${typeof data[key]}`);
        } else if (type === 'array' && Array.isArray(data[key])) {
          // Check that all array elements are strings
          const nonStringElements = data[key].filter(item => typeof item !== 'string');
          if (nonStringElements.length > 0) {
            errors.push(`Field ${key} should be array of strings, but contains non-string elements`);
          }
        }
      }
      return errors;
    };

    // Retry helper with exponential backoff
    const retryWithBackoff = async (fn, maxAttempts = 3, delayMs = 60000) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (attempt === maxAttempts) {
            throw err;
          }
          
          log(`Attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    };

    // Authenticate with Wykop API
    const wykopAuthResponse = await fetch('https://wykop.pl/api/v3/auth', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          key: process.env.WYKOP_API_KEY,
          secret: process.env.WYKOP_API_SECRET
        }
      })
    });

    const wykopAuthResponseJson = await wykopAuthResponse.json();
    const wykopToken = wykopAuthResponseJson.data.token;

    // Fetch page 1 and page 2
    const [wykopWpisyResponse1, wykopWpisyResponse2] = await Promise.all([
      fetch('https://wykop.pl/api/v3/tags/gielda/stream?page=1&limit=50&sort=all&type=all&multimedia=false', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${wykopToken}`
        }
      }),
      fetch('https://wykop.pl/api/v3/tags/gielda/stream?page=2&limit=50&sort=all&type=all&multimedia=false', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${wykopToken}`
        }
      })
    ]);

    const [wykopWpisyResponseJson1, wykopWpisyResponseJson2] = await Promise.all([
      wykopWpisyResponse1.json(),
      wykopWpisyResponse2.json()
    ]);

    // Combine data from both pages
    const allData = [...wykopWpisyResponseJson1.data, ...wykopWpisyResponseJson2.data];

    // Parse and filter the Wykop data
    const parseComment = (comment) => ({
      id: comment.id,
      username: comment.author.username,
      created_at: comment.created_at,
      votes: comment.votes.up,
      content: comment.content,
      media: comment.media
    });

    const parsedData = allData.map(entry => ({
      id: entry.id,
      username: entry.author.username,
      created_at: entry.created_at,
      votes: entry.votes.up,
      content: entry.content,
      comments: entry.comments?.items?.map(parseComment),
      media: entry.media
    }));

    log(`Generating sentiment for ${parsedData.length} posts.`);

    const responseFormat = `{"sentiment": "<sentyment (tylko liczba): string>",
    "summary": "<analiza nastrojow na tagu (max 800 znakow): string>",
    "mostDiscussed": "<trzy najczesciej omawiane spolki lub aktywa: array of strings, e.g. ["<nazwa aktywa 1>: <krotkie uzasadnienie 1>", "<nazwa aktywa 2>: <krotkie uzasadnienie 2>", "<nazwa aktywa 3>: <krotkie uzasadnienie 3>"]>",
    "mostActiveUsers": "<top 3 najaktywniejszych uzytkownikow, przy kazdym dodaj (BULLISH) lub (BEARISH) i krotki cytat: array of strings, e.g. ["<nazwa uzytkownika 1> (BULLISH): <krotki cytat 1>", "<nazwa uzytkownika 2> (BEARISH): <krotki cytat 2>", "<nazwa uzytkownika 3> (BULLISH): <krotki cytat 3>"]>"
    }`;

    const prompt = `Przeanalizuj najnowsze wpisy z tagu #gielda na portalu wykop.pl i oszacuj obecny sentyment uzytkownikow w skali 1-100,
    gdzie 1 to ekstremalnie bearish, a 100 to ekstremalnie bullish. Uzyj cytatow jako uzasadnienia.
    Odpowiedz w nastepujacym formacie JSON: ${responseFormat}.
    Wpisy: ${JSON.stringify(parsedData)}`;

    const sentimentSchema = {
      sentiment: 'string',
      summary: 'string',
      mostDiscussed: 'array',
      mostActiveUsers: 'array'
    };

    let sentimentResult;
    await retryWithBackoff(async () => {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction,
          tools: [{urlContext: {}}],
        },
      });

      log("AI response: " + response.text);

      try {
        sentimentResult = JSON.parse(response.text);
      } catch (parseError) {
        error("Failed to parse AI response as JSON: " + parseError.message);
        error("Raw response: " + response.text);
        throw new Error("AI returned invalid JSON: " + parseError.message);
      }

      // Validate schema
      const schemaErrors = validateSchema(sentimentResult, sentimentSchema);
      if (schemaErrors.length > 0) {
        error("Schema validation failed: " + schemaErrors.join(', '));
        error("Raw response: " + response.text);
        throw new Error("AI response doesn't match expected schema: " + schemaErrors.join(', '));
      }
    });
    
    // Ensure mostActiveUsers and mostDiscussed are strings
    if (Array.isArray(sentimentResult.mostActiveUsers)) {
      sentimentResult.mostActiveUsers = JSON.stringify(sentimentResult.mostActiveUsers);
    }
    if (Array.isArray(sentimentResult.mostDiscussed)) {
      sentimentResult.mostDiscussed = JSON.stringify(sentimentResult.mostDiscussed);
    }

    // --- TOMEK INDICATOR SECTION ---

    // Fetch Tomek's posts
    const [tomekResponse1, tomekResponse2] = await Promise.all([
      fetch('https://wykop.pl/api/v3/profile/users/tom-ek12333/actions?page=1&limit=50', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${wykopToken}`
        }
      }),
      fetch('https://wykop.pl/api/v3/profile/users/tom-ek12333/actions?page=2&limit=50', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${wykopToken}`
        }
      })
    ]);

    const [tomekJson1, tomekJson2] = await Promise.all([
      tomekResponse1.json(),
      tomekResponse2.json()
    ]);

    // Combine Tomek's data
    const allTomekData = [...tomekJson1.data, ...tomekJson2.data];

    // Parse Tomek's data
    const parsedTomekData = allTomekData.map(entry => ({
      id: entry.id,
      username: entry.author.username,
      created_at: entry.created_at,
      votes: entry.votes.up,
      tags: entry.tags,
      content: entry.content,
      comments: entry.comments?.items?.map(parseComment),
      media: entry.media
    }));

    // Filter for #gielda posts from last 3 days
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    
    const filteredTomekData = parsedTomekData.filter(entry => {
      const entryDate = new Date(entry.created_at);
      return entry.tags.includes('gielda') && entryDate >= threeDaysAgo;
    });

    let tomekSentimentResult;

    if (filteredTomekData.length === 0) {
      log("No Tomek posts found in the last 3 days with #gielda tag.");
      tomekSentimentResult = {
        sentiment: "0",
        summary: "Tomek od kilku dni siedzi cicho - albo mamy pompę stulecia i siedzi w norze, albo krach stulecia i siedzi na Bahamach za hajs ze 100-letnich obligacji."
      };
    } else {
      log(`Generating Tomek sentiment for ${filteredTomekData.length} posts from the last 3 days.`);

      const tomekResponseFormat = `
      {"sentiment": "<sentyment (tylko liczba): string>",
      "summary": "<analiza nastroju Tomka (max 300 znakow): string>"}`;

      const tomekPrompt = `Z lekka szydera, ale tez sympatia przeanalizuj najnowsze wpisy uzytkownika tom-ek12333 z tagu #gielda na portalu wykop.pl.
      Oszacuj jego obecny sentyment w skali 1-100, gdzie 1 to ekstremalnie bearish, a 100 to ekstremalnie bullish. Uzyj cytatow jako uzasadnienia.
      Odpowiedz w nastepujacym formacie JSON: ${tomekResponseFormat}.
      Wpisy: ${JSON.stringify(filteredTomekData)}`;

      const tomekSchema = {
        sentiment: 'string',
        summary: 'string'
      };

      await retryWithBackoff(async () => {
        const tomekResponse = await ai.models.generateContent({
          model: model,
          contents: tomekPrompt,
          config: {
            systemInstruction: systemInstruction,
            tools: [{urlContext: {}}],
          },
        });

        log("Tomek AI response: " + tomekResponse.text);

        try {
          tomekSentimentResult = JSON.parse(tomekResponse.text);
        } catch (parseError) {
          error("Failed to parse Tomek AI response as JSON: " + parseError.message);
          error("Raw response: " + tomekResponse.text);
          throw new Error("Tomek AI returned invalid JSON: " + parseError.message);
        }

        // Validate schema
        const schemaErrors = validateSchema(tomekSentimentResult, tomekSchema);
        if (schemaErrors.length > 0) {
          error("Tomek schema validation failed: " + schemaErrors.join(', '));
          error("Raw response: " + tomekResponse.text);
          throw new Error("Tomek AI response doesn't match expected schema: " + schemaErrors.join(', '));
        }
      });
    }

    // --- IMAGE GENERATION SECTION ---
    let imageId = null;
    try {
      log("Generating image");
      
      const baseImageBuffer = await storage.getFileDownload(
        '6961715000182498a35a', // Bucket ID
        'wykopindex_v2' // File ID
      );

      const baseImage = await loadImage(Buffer.from(baseImageBuffer));
      
      const canvas = createCanvas(baseImage.width, baseImage.height);
      const ctx = canvas.getContext('2d');
      
      ctx.drawImage(baseImage, 0, 0);
      
      // Calculate needle parameters (image size: 1433 x 933)
      const sentiment = parseInt(sentimentResult.sentiment);
      const centerX = canvas.width / 2 + 5;
      const centerY = canvas.height * 0.915; // 8.5% from bottom = 91.5% from top (matching frontend)
      const needleLength = 400; // Fixed length
      const angle = (-90 + (sentiment * 1.8)) * Math.PI / 180; // Convert to radians
      
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(angle);
      
      ctx.beginPath();
      ctx.moveTo(0, -needleLength); // Tip of arrow
      ctx.lineTo(-10, 0); // width (left base)
      ctx.lineTo(10, 0); // width (right base)
      ctx.closePath();
      
      ctx.fillStyle = '#575757';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;
      ctx.fill();
      
      ctx.restore();
      
      const imageBuffer = canvas.toBuffer('image/png');
      
      log("Uploading image to storage");
      const timestamp = Date.now();
      const fileName = `wykopindex-${timestamp}`;
      
      const uploadedFile = await storage.createFile(
        '6961715000182498a35a', // Bucket ID
        fileName, // File ID with timestamp
        InputFile.fromBuffer(imageBuffer, `${fileName}.png`)
      );

      imageId = uploadedFile.$id;
      log(`Image uploaded successfully: ${imageId}`);
    } catch (imageError) {
      error("Failed to generate or upload image: " + imageError.message);
      log("Continuing with null imageId");
    }

    log("Saving to database");

    const dbResult = await databases.createDocument(
        '69617178003ac8ef4fba',
        'sentiment',
        sdk.ID.unique(),
        {
          sentiment: parseInt(sentimentResult.sentiment),
          summary: sentimentResult.summary,
          mostActiveUsers: sentimentResult.mostActiveUsers,
          mostDiscussed: sentimentResult.mostDiscussed,
          tomekSentiment: parseInt(tomekSentimentResult.sentiment),
          tomekSummary: tomekSentimentResult.summary,
          imageId: imageId
        }
    );

    log("Database entry added: " + dbResult.$id);

    return res.empty();
  } catch(err) {
    error("Error: " + err.message);
    return res.json({
      error: err.message
    }, 500);
  }
};
