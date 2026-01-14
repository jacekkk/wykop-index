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
    const systemInstruction = `You are a helpful assistant that analyzes Polish social media sentiment about stock markets.
    Always respond with a valid JSON, don't include any additional characters or formatting around JSON response.`;

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

    const responseFormat = `{"sentiment": "<sentyment. string format>", "summary": "<analiza nastrojow na tagu, max 600 znakow. string format>", "mostActiveUsers": "<top 3 najaktywniejszych uzytkownikow, przy kazdym dodaj (bullish) lub (bearish) i krotki cytat. array format>", "mostDiscussed": "<najczesciej omawiane spolki lub aktywa, max 3, przy kazdym dodaj krotkie uzasadnienie. array format>"}`;

    const prompt = `Przenalizuj najnowsze wpisy z tagu #gielda na portalu wykop.pl i oszacuj obecny sentyment uzytkownikow w skali 1-100,
    gdzie 1 to ekstremalnie bearish, a 100 to ekstremalnie bullish. Uzyj cytatow jako uzasadnienia.
    Odpowiedz w nastepujacym formacie JSON: ${responseFormat}.
    Wpisy: ${JSON.stringify(parsedData)}`;

    const response = await ai.models.generateContent({
      model: model,
      contents: prompt,
      config: {
        systemInstruction: systemInstruction,
        tools: [{urlContext: {}}],
      },
    });

    let sentimentResult;
    try {
      sentimentResult = JSON.parse(response.text);
      log("Sentiment: " + sentimentResult.sentiment);
    } catch (parseError) {
      error("Failed to parse AI response as JSON: " + parseError.message);
      error("Raw response: " + response.text);
      throw new Error("AI returned invalid JSON: " + parseError.message);
    }
    
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

    log(`Generating Tomek sentiment for ${filteredTomekData.length} posts from the last 3 days.`);

    const tomekResponseFormat = `{"sentiment": "<sentyment>", "summary": "<analiza nastroju Tomka, max 300 znakow>"}`;

    const tomekPrompt = `Z lekka szydera, ale tez sympatia przenalizuj najnowsze wpisy uzytkownika tom-ek12333 z tagu #gielda na portalu wykop.pl.
    Oszacuj jego obecny sentyment w skali 1-100, gdzie 1 to ekstremalnie bearish, a 100 to ekstremalnie bullish. Uzyj cytatow jako uzasadnienia.
    Odpowiedz w nastepujacym formacie JSON: ${tomekResponseFormat}.
    Wpisy: ${JSON.stringify(filteredTomekData)}`;

    const tomekResponse = await ai.models.generateContent({
      model: model,
      contents: tomekPrompt,
      config: {
        systemInstruction: systemInstruction,
        tools: [{urlContext: {}}],
      },
    });

    let tomekSentimentResult;
    try {
      tomekSentimentResult = JSON.parse(tomekResponse.text);
      log("Tomek sentiment: " + tomekSentimentResult.sentiment);
    } catch (parseError) {
      error("Failed to parse Tomek AI response as JSON: " + parseError.message);
      error("Raw response: " + tomekResponse.text);
      throw new Error("Tomek AI returned invalid JSON: " + parseError.message);
    }

    // --- IMAGE GENERATION SECTION ---
    let imageId = null;
    try {
      log("Generating image");
      
      // Download the base image from storage
      const baseImageBuffer = await storage.getFileDownload(
        '6961715000182498a35a', // Bucket ID
        'wykopindex' // File ID
      );

      // Load the base image
      const baseImage = await loadImage(Buffer.from(baseImageBuffer));
      
      // Create canvas with same dimensions as base image
      const canvas = createCanvas(baseImage.width, baseImage.height);
      const ctx = canvas.getContext('2d');
      
      // Draw base image
      ctx.drawImage(baseImage, 0, 0);
      
      // Calculate needle parameters (image size: 1433 x 933)
      const sentiment = parseInt(sentimentResult.sentiment);
      const centerX = canvas.width / 2 + 5;
      const centerY = canvas.height * 0.915; // 8.5% from bottom = 91.5% from top (matching frontend)
      const needleLength = 300; // Fixed length
      const angle = (-90 + (sentiment * 1.8)) * Math.PI / 180; // Convert to radians
      
      // Draw the needle (triangle arrow) from center pivot point
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(angle);
      
      // Draw triangle pointing up (along needle direction from pivot)
      ctx.beginPath();
      ctx.moveTo(0, -needleLength); // Tip of arrow
      ctx.lineTo(-8, 0); // width (left base)
      ctx.lineTo(8, 0); // width (right base)
      ctx.closePath();
      
      ctx.fillStyle = '#575757';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;
      ctx.fill();
      
      ctx.restore();
      
      // Convert canvas to buffer
      const imageBuffer = canvas.toBuffer('image/png');
      
      // Upload to storage as a new file with timestamp
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
