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

    let model = 'gemini-3-flash-preview';
    const systemInstruction = `You are a helpful assistant that analyzes sentiment about stock markets on a Polish social media platform.
    The username of an account from which your responses are posted is KrachSmieciuchIndex.

    BEHAVIORAL RULES:
    - Always respond in Polish.
    - When quoting the users, do not censor their language - quote the full words, including any swear words (e.g. "kurwa", not "k...").

    CRITICAL: You MUST respond with ONLY raw JSON. DO NOT wrap your response in markdown code blocks. DO NOT add any text before or after the JSON. Your entire response must be valid JSON that can be directly parsed.`;

    // Helper function to clean markdown code blocks from JSON responses
    const cleanJsonResponse = (text) => {
      // Remove markdown code block markers
      let cleaned = text.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.slice(7);
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.slice(3);
      }
      if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, -3);
      }
      return JSON.parse(cleaned.trim());
    };

    // Schema validation helper
    const validateSchema = (data, schema) => {
      const errors = [];
      for (const [key, config] of Object.entries(schema)) {
        const type = typeof config === 'string' ? config : config.type;
        const requiredFields = config.requiredFields || [];
        
        if (!(key in data)) {
          errors.push(`Missing field: ${key}`);
        } else if (type === 'string' && typeof data[key] !== 'string') {
          errors.push(`Field ${key} should be string, got ${typeof data[key]}`);
        } else if (type === 'array-of-objects' && !Array.isArray(data[key])) {
          errors.push(`Field ${key} should be array, got ${typeof data[key]}`);
        } else if (type === 'array-of-objects' && Array.isArray(data[key])) {
          // Check that all array elements are objects
          const nonObjectElements = data[key].filter(item => typeof item !== 'object' || item === null);
          if (nonObjectElements.length > 0) {
            errors.push(`Field ${key} should be array of objects, but contains non-object elements`);
          }
          // Check required fields in each object
          if (requiredFields.length > 0) {
            data[key].forEach((item, index) => {
              requiredFields.forEach(field => {
                if (!(field in item)) {
                  errors.push(`Field ${key}[${index}] is missing required field: ${field}`);
                }
              });
            });
          }
        }
      }
      return errors;
    };

    // Retry helper with exponential backoff
    const retryWithBackoff = async (fn, maxAttempts = 3, delayMs = 30000) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // Change model to gemini-2.5-flash on 3rd attempt
          if (attempt === 3) {
            model = 'gemini-2.5-flash';
            log(`Switching to ${model} for final attempt`);
          }
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
    let wykopAuthResponse = await fetch('https://wykop.pl/api/v3/auth', {
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

    if (!wykopAuthResponse.ok) {
      throw new Error(`Wykop auth failed: ${wykopAuthResponse.status} ${await wykopAuthResponse.text()}`);
    }

    let wykopAuthResponseJson = await wykopAuthResponse.json();
    let wykopToken = wykopAuthResponseJson.data.token;
    log("Successfully authenticated with Wykop using API key");

    // Get current UTC time and calculate Poland offset (UTC+1 or UTC+2 depending on DST)
    const nowUTC = new Date();
    const nowPolandStr = nowUTC.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' });
    const polandOffset = new Date(nowPolandStr).getTime() - nowUTC.getTime();
    
    // For Wykop API operations, we work with Poland time since API returns Poland timestamps
    const hoursToLookBack = 6.5; // 6 hours + 30 min buffer for any delays
    const lookBackTime = new Date(nowUTC.getTime() - hoursToLookBack * 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(nowUTC.getTime() - 24 * 60 * 60 * 1000);

    // --- TAG STATS SECTION ---
    const tagResponse = await fetch('https://wykop.pl/api/v3/tags/gielda', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${wykopToken}`
        }
      });

    if (!tagResponse.ok) {
      throw new Error(`Wykop tag stats fetch failed: ${tagResponse.status} ${await tagResponse.text()}`);
    }

    const tagResponseJson = await tagResponse.json();
    const followersCount = tagResponseJson.data.followers;

    log('Starting to count posts from the last 24 hours...');
    let batchSize = 5; // Fetch 5 pages at once
    let entriesLast24h = 0;
    let currentBatchStart = 1;
    let shouldContinue = true;
    let newestEntryTime = null;
    let oldestEntryTime = null;
    const userEntryCounts = {};
    const userCommentCounts = {};

    while (shouldContinue) {
      const pageNumbers = Array.from({ length: batchSize }, (_, i) => currentBatchStart + i);
      log(`Fetching pages ${pageNumbers[0]}-${pageNumbers[pageNumbers.length - 1]}`);

      const responses = await Promise.all(
        pageNumbers.map(page => 
          fetch(`https://wykop.pl/api/v3/tags/gielda/stream?page=${page}&limit=50&sort=all&type=all&multimedia=false`, {
            method: 'GET',
            headers: {
              'accept': 'application/json',
              'Authorization': `Bearer ${wykopToken}`
            }
          })
        )
      );

      const pagesData = await Promise.all(responses.map(r => r.json()));

      for (let i = 0; i < pagesData.length; i++) {
        const entries = pagesData[i].data;
        if (!entries || entries.length === 0) {
          shouldContinue = false;
          break;
        }

        let recentCount = 0;
        for (const entry of entries) {
          // Wykop API returns Poland time, parse as UTC then subtract Poland offset
          const entryDate = new Date(entry.created_at.replace(' ', 'T') + 'Z');
          if (entryDate.getTime() - polandOffset >= twentyFourHoursAgo.getTime()) {
            recentCount++;
            if (!newestEntryTime) newestEntryTime = entry.created_at;
            oldestEntryTime = entry.created_at;
            
            // Count entries per user
            const username = entry.author.username;
            userEntryCounts[username] = (userEntryCounts[username] || 0) + 1;
            
            // Count comments per user
            if (entry.comments?.items) {
              for (const comment of entry.comments.items) {
                const commentUsername = comment.author.username;
                userCommentCounts[commentUsername] = (userCommentCounts[commentUsername] || 0) + 1;
              }
            }
          } else {
            entriesLast24h += recentCount;
            shouldContinue = false;
            break;
          }
        }

        if (!shouldContinue) break;
        entriesLast24h += recentCount;
      }
      currentBatchStart += batchSize;
    }
    
    // Helper to find top user(s) from counts object
    const getTopUser = (counts) => {
      const entries = Object.entries(counts);
      if (entries.length === 0) return { username: '', count: 0 };
      
      const sorted = entries.sort((a, b) => b[1] - a[1]);
      const maxCount = sorted[0][1];
      
      // Find all users with the max count
      const topUsers = sorted.filter(([_, count]) => count === maxCount);
      
      // Always prepend @ to usernames
      const username = topUsers.map(([user, _]) => `@${user}`).join(', ');
      
      return { username, count: maxCount };
    };
    
    // Find top users
    const topEntryUser = getTopUser(userEntryCounts);
    const topCommentUser = getTopUser(userCommentCounts);
    
    // Calculate combined totals
    const allUsers = new Set([...Object.keys(userEntryCounts), ...Object.keys(userCommentCounts)]);
    const userCombinedCounts = {};
    for (const user of allUsers) {
      userCombinedCounts[user] = (userEntryCounts[user] || 0) + (userCommentCounts[user] || 0);
    }
    
    const topCombinedUser = getTopUser(userCombinedCounts);

    // Helper to format timestamps as UTC strings
    const formatDateTime = (date) => {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      const hours = String(date.getUTCHours()).padStart(2, '0');
      const minutes = String(date.getUTCMinutes()).padStart(2, '0');
      const seconds = String(date.getUTCSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
    };

    // Log times of entries from the last 24h in UTC and Poland time
    if (newestEntryTime && oldestEntryTime) {
      const newestEntryUTC = formatDateTime(new Date(new Date(newestEntryTime.replace(' ', 'T') + 'Z').getTime() - polandOffset));
      const oldestEntryUTC = formatDateTime(new Date(new Date(oldestEntryTime.replace(' ', 'T') + 'Z').getTime() - polandOffset));
      log(`Got ${entriesLast24h} posts from the last 24h between ${oldestEntryUTC} - ${newestEntryUTC} (Polish time: ${oldestEntryTime} - ${newestEntryTime})`);
    } else {
      log(`Got ${entriesLast24h} posts from the last 24h`);
    }

    // --- SENTIMENT ANALYSIS SECTION ---

    batchSize = 5; // Fetch 5 pages at once for sentiment analysis
    currentBatchStart = 1;
    shouldContinue = true;
    let recentEntries = [];

    while (shouldContinue) {
      const pageNumbers = Array.from({ length: batchSize }, (_, i) => currentBatchStart + i);
      log(`Fetching pages ${pageNumbers[0]}-${pageNumbers[pageNumbers.length - 1]} for sentiment analysis`);

      const responses = await Promise.all(
        pageNumbers.map(page =>
          fetch(`https://wykop.pl/api/v3/tags/gielda/stream?page=${page}&limit=50&sort=all&type=all&multimedia=false`, {
            method: 'GET',
            headers: {
              'accept': 'application/json',
              'Authorization': `Bearer ${wykopToken}`
            }
          })
        )
      );

      const pagesData = await Promise.all(responses.map(r => r.json()));

      for (let i = 0; i < pagesData.length; i++) {
        const entries = pagesData[i].data;
        if (!entries || entries.length === 0) {
          shouldContinue = false;
          break;
        }

        for (const entry of entries) {
          // Wykop API returns Poland time, parse as UTC then subtract Poland offset
          const entryDate = new Date(entry.created_at.replace(' ', 'T') + 'Z');
          const entryTimeUTC = entryDate.getTime() - polandOffset;
          if (entryTimeUTC >= lookBackTime.getTime()) {
            recentEntries.push(entry);
          } else if (entryTimeUTC < lookBackTime.getTime()) {
            // Found an entry older than lookback time, stop
            shouldContinue = false;
            break;
          }
        }

        if (!shouldContinue) break;
      }
      currentBatchStart += batchSize;
    }

    // Helper function to strip query parameters from URL
    const stripQueryParams = (url) => url ? url.split('?')[0] : null;

    const parseComment = (comment, entryId) => ({
      id: comment.id,
      url: `https://wykop.pl/wpis/${entryId}#${comment.id}`,
      username: comment.author.username,
      created_at: comment.created_at,
      votes: comment.votes.up,
      content: comment.content,
      photo_url: stripQueryParams(comment.media?.photo?.url),
      embed_url: stripQueryParams(comment.media?.embed?.url)
    });

    const parsePosts = (posts) => posts.map(entry => ({
      id: entry.id,
      url: `https://wykop.pl/wpis/${entry.id}`,
      username: entry.author.username,
      created_at: entry.created_at,
      votes: entry.votes.up,
      content: entry.content,
      comments: entry.comments?.items?.map(comment => parseComment(comment, entry.id)),
      photo_url: stripQueryParams(entry.media?.photo?.url),
      embed_url: stripQueryParams(entry.media?.embed?.url)
    }));

    const parsedData = parsePosts(recentEntries);

    // Log times of entries for sentiment analysis in UTC and Poland time
    if (parsedData.length > 0) {
      const oldestEntryTime = parsedData[parsedData.length - 1].created_at;
      const newestEntryTime = parsedData[0].created_at;
      const oldestParsedUTC = formatDateTime(new Date(new Date(oldestEntryTime.replace(' ', 'T') + 'Z').getTime() - polandOffset));
      const newestParsedUTC = formatDateTime(new Date(new Date(newestEntryTime.replace(' ', 'T') + 'Z').getTime() - polandOffset));
      log(`Got ${parsedData.length} posts between ${oldestParsedUTC} - ${newestParsedUTC} (Polish time: ${oldestEntryTime} - ${newestEntryTime})`);
    } else {
      log('No posts to analyze');
    }

    const prompt = `Przeanalizuj najnowsze wpisy z tagu #gielda na portalu wykop.pl i oszacuj obecny sentyment uzytkownikow w skali 1-100,
    gdzie 1 to ekstremalnie bearish, a 100 to ekstremalnie bullish. Uzyj cytatow jako uzasadnienia.
    
    Odpowiedz w nastepujacym formacie JSON:
    {
      "sentiment": "liczba od 1 do 100 jako string",
      "summary": "analiza nastrojow na tagu (max 800 znakow)",
      "mostDiscussed": [
        {"asset": "nazwa spolki/aktywa", "reasoning": "krotkie uzasadnienie"},
        {"asset": "nazwa spolki/aktywa", "reasoning": "krotkie uzasadnienie"},
        {"asset": "nazwa spolki/aktywa", "reasoning": "krotkie uzasadnienie"}
      ],
      "topQuotes": [
        {"username": "nazwa uzytkownika", "sentiment": "BULLISH/BEARISH/NEUTRALNY", "quote": "krotki cytat", "url": "link do wpisu lub komentarza ktory zawiera cytat"},
        {"username": "nazwa uzytkownika", "sentiment": "BULLISH/BEARISH/NEUTRALNY", "quote": "krotki cytat", "url": "link do wpisu lub komentarza ktory zawiera cytat"},
        {"username": "nazwa uzytkownika", "sentiment": "BULLISH/BEARISH/NEUTRALNY", "quote": "krotki cytat", "url": "link do wpisu lub komentarza ktory zawiera cytat"}
      ]
    }
    
    WAZNE:
    - mostDiscussed: trzy najczesciej omawiane spolki lub aktywa.
    - topQuotes: top 3 krotkich cytatow z najczesciej plusowanych wpisow uzytkownikow. UWAGA: Upewnij sie, ze pole username to uzytkownik, ktory faktycznie napisal dany cytat, a nie inny uzytkownik, ktory skomentowal ten sam wpis.
    - Wszystkie pola w odpowiedzi sa wymagane.
    
    Wpisy: ${JSON.stringify(parsedData)}`;

    const sentimentSchema = {
      sentiment: 'string',
      summary: 'string',
      mostDiscussed: { type: 'array-of-objects', requiredFields: ['asset', 'reasoning'] },
      topQuotes: { type: 'array-of-objects', requiredFields: ['username', 'sentiment', 'quote', 'url'] }
    };

    let sentimentResult;
    await retryWithBackoff(async () => {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          httpOptions: {
            timeout: 120000, // 120 seconds
          },
          systemInstruction: systemInstruction,
          tools: [{urlContext: {}}],
        },
      });

      log("AI response: " + JSON.stringify(response.text));

      try {
        sentimentResult = cleanJsonResponse(response.text);
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
    
    if (Array.isArray(sentimentResult.topQuotes)) {
      sentimentResult.topQuotes = JSON.stringify(sentimentResult.topQuotes);
    }
    if (Array.isArray(sentimentResult.mostDiscussed)) {
      sentimentResult.mostDiscussed = JSON.stringify(sentimentResult.mostDiscussed);
    }

    // --- TOMEK INDICATOR SECTION ---

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

    const allTomekData = [...tomekJson1.data, ...tomekJson2.data];
    const recentTomekData = allTomekData.filter(entry => {
      // Wykop API returns Poland time, parse as UTC then subtract Poland offset
      const entryDate = new Date(entry.created_at.replace(' ', 'T') + 'Z');
      return entryDate.getTime() - polandOffset >= twentyFourHoursAgo.getTime();
    });

    // Log times of Tomek entries in UTC and Poland time
    if (recentTomekData.length > 0) {
      const newestTomekTime = recentTomekData[0].created_at;
      const oldestTomekTime = recentTomekData[recentTomekData.length - 1].created_at;
      const newestTomekUTC = formatDateTime(new Date(new Date(newestTomekTime.replace(' ', 'T') + 'Z').getTime() - polandOffset));
      const oldestTomekUTC = formatDateTime(new Date(new Date(oldestTomekTime.replace(' ', 'T') + 'Z').getTime() - polandOffset));
      log(`Got ${recentTomekData.length} Tomek posts between ${oldestTomekUTC} - ${newestTomekUTC} (Polish time: ${oldestTomekTime} - ${newestTomekTime})`);
    } else {
      log('No Tomek posts from the last 24h with #gielda tag');
    }

    const parsedTomekData = parsePosts(recentTomekData);

    let tomekSentimentResult;

    if (parsedTomekData.length === 0) {
      tomekSentimentResult = {
        sentiment: "0",
        summary: "Tomek od wczoraj siedzi cicho - albo mamy pompę stulecia i siedzi w norze, albo krach stulecia i siedzi na Bahamach za hajs ze 100-letnich obligacji."
      };
    } else {
      const tomekPrompt = `Z lekka szydera, ale tez sympatia przeanalizuj najnowsze wpisy uzytkownika tom-ek12333 z tagu #gielda na portalu wykop.pl.
      Oszacuj jego obecny sentyment w skali 1-100, gdzie 1 to ekstremalnie bearish, a 100 to ekstremalnie bullish.
      
      Odpowiedz w nastepujacym formacie JSON:
      {
        "sentiment": "liczba od 1 do 100 jako string",
        "summary": "analiza nastroju Tomka (max 500 znakow) - uzyj cytatow jako uzasadnienia"
      }
      
      WAZNE:
      - Jezeli wpis lub komentarz zawiera zalacznik (pole photo_url lub embed_url) to uwzglednij tresc zalacznika jako czesc wpisu do analizy sentymentu Tomka.
      - Wszystkie pola w odpowiedzi sa wymagane.
      
      Wpisy: ${JSON.stringify(parsedTomekData)}`;

      const tomekSchema = {
        sentiment: 'string',
        summary: 'string'
      };

      await retryWithBackoff(async () => {
        const tomekResponse = await ai.models.generateContent({
          model: model,
          contents: tomekPrompt,
          config: {
            httpOptions: {
              timeout: 120000, // 120 seconds
            },
            systemInstruction: systemInstruction,
            tools: [{urlContext: {}}],
          },
        });

        log("Tomek response: " + JSON.stringify(tomekResponse.text));

        try {
          tomekSentimentResult = cleanJsonResponse(tomekResponse.text);
        } catch (parseError) {
          error("Failed to parse Tomek response as JSON: " + parseError.message);
          error("Raw response: " + tomekResponse.text);
          throw new Error("Tomek returned invalid JSON: " + parseError.message);
        }

        // Validate schema
        const schemaErrors = validateSchema(tomekSentimentResult, tomekSchema);
        if (schemaErrors.length > 0) {
          error("Tomek schema validation failed: " + schemaErrors.join(', '));
          error("Raw response: " + tomekResponse.text);
          throw new Error("Tomek response doesn't match expected schema: " + schemaErrors.join(', '));
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

    // --- SAVE TO DATABASE SECTION ---

    log("Saving to database");

    const dbResult = await databases.createDocument(
        '69617178003ac8ef4fba',
        'sentiment',
        sdk.ID.unique(),
        {
          sentiment: parseInt(sentimentResult.sentiment),
          summary: sentimentResult.summary,
          mostActiveUsers: sentimentResult.topQuotes,
          mostDiscussed: sentimentResult.mostDiscussed,
          tomekSentiment: parseInt(tomekSentimentResult.sentiment),
          tomekSummary: tomekSentimentResult.summary,
          imageId: imageId,
          followers: followersCount,
          entriesLast24h: entriesLast24h,
          mostEntriesLast24h: JSON.stringify(topEntryUser),
          mostCommentsLast24h: JSON.stringify(topCommentUser),
          mostCombinedLast24h: JSON.stringify(topCombinedUser)
        }
    );

    log("Database entry added: " + dbResult.$id);

    // --- POST TO WYKOP SECTION ---
    
    try {
      // Fetch historical sentiment data from the last 30 days (after saving, so we can exclude the new entry)
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const lastThirtyDaysData = await databases.listDocuments(
        '69617178003ac8ef4fba',
        'sentiment',
        [
          sdk.Query.greaterThan('$createdAt', thirtyDaysAgo.toISOString()),
          sdk.Query.orderAsc('$createdAt'),
          sdk.Query.limit(150)
        ]
      );

      // Use UTC for date boundaries since database stores timestamps in UTC
      const startOfTodayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const startOfYesterdayUTC = new Date(startOfTodayUTC.getTime() - 24 * 60 * 60 * 1000);
      
      // Get yesterday's sentiment and entry count
      const yesterdayEntries = lastThirtyDaysData.documents.filter(doc => {
        if (doc.$id === dbResult.$id) return false; // Exclude the just-saved entry to guard against edge cases due to timing
        const docDate = new Date(doc.$createdAt);
        return docDate >= startOfYesterdayUTC && docDate < startOfTodayUTC;
      });

      log(`Yesterday entries: ${JSON.stringify(yesterdayEntries.map(e => 
        ({ id: e.$id, createdAt: e.$createdAt, sentiment: e.sentiment, entriesLast24h: e.entriesLast24h, followers: e.followers })
      ))}`);

      const totalSentiment = yesterdayEntries.reduce((sum, doc) => sum + doc.sentiment, 0);
      const yesterdaySentiment = yesterdayEntries.length > 0 ? Math.round(totalSentiment / yesterdayEntries.length) : null;
      const yesterdayEntryCount = yesterdayEntries.length > 0 ? yesterdayEntries[yesterdayEntries.length - 1].entriesLast24h : null;
      log(`Yesterday's average sentiment: ${yesterdaySentiment} (from ${yesterdayEntries.length} entries)`);

      // Get followers from a week ago
      const startOfWeekAgoUTC = new Date(startOfTodayUTC.getTime() - 7 * 24 * 60 * 60 * 1000);
      const endOfWeekAgoUTC = new Date(startOfWeekAgoUTC.getTime() + 24 * 60 * 60 * 1000);
      const weekAgoEntries = lastThirtyDaysData.documents.filter(doc => {
        if (doc.$id === dbResult.$id) return false;
        const docDate = new Date(doc.$createdAt);
        return docDate >= startOfWeekAgoUTC && docDate < endOfWeekAgoUTC;
      });
      const followersWeekAgo = weekAgoEntries.length > 0 ? weekAgoEntries[weekAgoEntries.length - 1].followers : null;

      // Authenticate with Wykop API
      wykopAuthResponse = await fetch('https://wykop.pl/api/v3/refresh-token', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          data: {
            refresh_token: process.env.WYKOP_REFRESH_TOKEN
          }
        })
      });

      if (!wykopAuthResponse.ok) {
        throw new Error(`Wykop auth failed: ${wykopAuthResponse.status} ${await wykopAuthResponse.text()}`);
      }

      wykopAuthResponseJson = await wykopAuthResponse.json();
      wykopToken = wykopAuthResponseJson.data.token;
      log("Successfully authenticated with Wykop using refresh token");
      
      // Format the post content
      const mostActiveUsers = JSON.parse(sentimentResult.topQuotes);
      const mostDiscussed = JSON.parse(sentimentResult.mostDiscussed);

      const formattedDate = new Date(dbResult.$createdAt).toLocaleString('pl-PL', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Warsaw'
      });

      const sentimentValue = parseInt(sentimentResult.sentiment);
      const emoji = sentimentValue <= 20 ? '💩' : sentimentValue <= 40 ? '🚽' : sentimentValue <= 60 ? '🆗' : sentimentValue <= 80 ? '🚀' : '🔥';
      const followersChange = followersWeekAgo !== null ? `${followersCount - followersWeekAgo >= 0 ? '+' : '-'}${followersCount - followersWeekAgo}` : '';
      const entriesChangePercentage = entriesLast24h && yesterdayEntryCount 
        ? `${(((entriesLast24h - yesterdayEntryCount) / yesterdayEntryCount) * 100) >= 0 ? '+' : ''}${Math.round((entriesLast24h - yesterdayEntryCount) / yesterdayEntryCount * 100)}%` 
        : '';
      
      const postContent = `[Krach & Śmieciuch Index](https://wykop-index.appwrite.network/) - stan na ${formattedDate}

**${sentimentResult.sentiment}/100 ${emoji}** ${yesterdaySentiment !== null ? `(wczoraj: ${yesterdaySentiment})` : ''}

${sentimentResult.summary}

**Najczęściej omawiane:**
${Array.isArray(mostDiscussed) && mostDiscussed.length > 0 ? mostDiscussed.slice(0, 3).map(topic => `🔥 ${topic.asset}: ${topic.reasoning}`).join('\n') : ''}

**Topowi analitycy:**
${Array.isArray(mostActiveUsers) && mostActiveUsers.length > 0 ? mostActiveUsers.slice(0, 3).map(user => `👤 @${user.username} (${user.sentiment}): [_"${user.quote}"_](${user.url})`).join('\n') : ''}

${tomekSentimentResult.sentiment && `\n**TomekIndicator®:** ${tomekSentimentResult.sentiment}/100\n${tomekSentimentResult.summary}`}

**Statystyki:**
👀 Obserwujący tag: ${followersCount} ${followersWeekAgo !== null ? `(tydzień temu: ${followersWeekAgo}; zmiana: ${followersChange})` : ''}
📜 Ilość wpisów w ostatnich 24h: ${entriesLast24h} ${yesterdayEntryCount !== null ? `(wczoraj: ${yesterdayEntryCount}; zmiana: ${entriesChangePercentage})` : ''}
🥇 Najaktywniejszy ogółem: ${topCombinedUser.username} (${topCombinedUser.count})
🥈 Najwięcej wpisów: ${topEntryUser.username} (${topEntryUser.count})
🥉 Najwięcej komentarzy: ${topCommentUser.username} (${topCommentUser.count})

❔ Masz pytanie? Oznacz mnie we wpisie lub komentarzu na #gielda ( ͡° ͜ʖ ͡°)

#gielda #wykopindex #krachsmieciuchindex`;

      // Try to upload image, but continue without it if it fails
      let photoKey = null;
      try {
        const fileId = imageId || 'wykopindex_v2';
        
        if (imageId) {
          log(`Using image ${fileId} in Wykop post`);
        } else {
          log(`No imageId found, using the default image: ${fileId}`);
        }

        const imageUrl = `${process.env.BUCKET_URL}/files/${fileId}/view?project=wykopindex`;
        log(`Uploading image to Wykop from URL: ${imageUrl}`);

        const uploadResponse = await fetch('https://wykop.pl/api/v3/media/photos?type=comments', {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${wykopToken}`
          },
          body: JSON.stringify({
            data: {
              url: imageUrl
            }
          })
        });

        if (uploadResponse.ok) {
          const uploadResult = await uploadResponse.json();
          photoKey = uploadResult.data.key;
          log("Image uploaded successfully");
        } else {
          const errorText = await uploadResponse.text();
          error(`Failed to upload image: ${uploadResponse.status} ${errorText}`);
          log("Continuing without image");
        }
      } catch (imageError) {
        error(`Error uploading image: ${imageError.message}`);
        log("Continuing without image");
      }

      log("Posting to Wykop");

      const postData = {
        content: postContent,
        adult: false
      };

      if (photoKey) {
        postData.photo = photoKey;
      }

      const postResponse = await fetch('https://wykop.pl/api/v3/entries', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${wykopToken}`
        },
        body: JSON.stringify({
          data: postData
        })
      });

      if (!postResponse.ok) {
        const errorText = await postResponse.text();
        throw new Error(`Failed to post to Wykop: ${postResponse.status} ${errorText}`);
      }

      const postResult = await postResponse.json();
      log(`Successfully posted to Wykop, entry ID: ${postResult.data.id}`);
    } catch (postError) {
      error(`Failed to post to Wykop: ${postError.message}`);
    }

    return res.empty();
  } catch(err) {
    error("Error: " + err.message);
    return res.json({
      error: err.message
    }, 500);
  }
};
