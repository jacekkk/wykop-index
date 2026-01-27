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
            log('Switching to gemini-2.5-flash for final attempt');
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
    log("Successfully authenticated with Wykop");

    const nowPoland = new Date().toLocaleString('en-US', { timeZone: 'Europe/Warsaw' });
    const currentTime = new Date(nowPoland);
    const twelveHoursAgo = new Date(currentTime.getTime() - 12 * 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(currentTime.getTime() - 24 * 60 * 60 * 1000);

    // --- FETCH WYKOP DATA SECTION ---

    const [wykopWpisyResponse1, wykopWpisyResponse2, wykopWpisyResponse3, wykopWpisyResponse4] = await Promise.all([
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
      }),
      fetch('https://wykop.pl/api/v3/tags/gielda/stream?page=3&limit=50&sort=all&type=all&multimedia=false', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${wykopToken}`
        }
      }),
      fetch('https://wykop.pl/api/v3/tags/gielda/stream?page=4&limit=50&sort=all&type=all&multimedia=false', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${wykopToken}`
        }
      }),
    ]);

    const [wykopWpisyResponseJson1, wykopWpisyResponseJson2, wykopWpisyResponseJson3, wykopWpisyResponseJson4] = await Promise.all([
      wykopWpisyResponse1.json(),
      wykopWpisyResponse2.json(),
      wykopWpisyResponse3.json(),
      wykopWpisyResponse4.json()
    ]);

    const allData = [...wykopWpisyResponseJson1.data, ...wykopWpisyResponseJson2.data, ...wykopWpisyResponseJson3.data, ...wykopWpisyResponseJson4.data];
    const recentData = allData.filter(entry => {
      // created_at format: "2026-01-16 11:27:44"
      const entryDate = new Date(entry.created_at.replace(' ', 'T'));
      return entryDate >= twelveHoursAgo;
    });

    log(`Got ${recentData.length} posts from the last 12 hours.`);

    const parseComment = (comment, entryId) => ({
      id: comment.id,
      url: `https://wykop.pl/wpis/${entryId}#${comment.id}`,
      username: comment.author.username,
      created_at: comment.created_at,
      votes: comment.votes.up,
      content: comment.content,
      photo_url: comment.media?.photo?.url || null,
      embed_url: comment.media?.embed?.url || null
    });

    const parsePosts = (posts) => posts.map(entry => ({
      id: entry.id,
      url: `https://wykop.pl/wpis/${entry.id}`,
      username: entry.author.username,
      created_at: entry.created_at,
      votes: entry.votes.up,
      content: entry.content,
      comments: entry.comments?.items?.map(comment => parseComment(comment, entry.id)),
      photo_url: entry.media?.photo?.url || null,
      embed_url: entry.media?.embed?.url || null
    }));

    const parsedData = parsePosts(recentData);

    log(`Generating sentiment for ${parsedData.length} posts between hours: ${parsedData[parsedData.length -1].created_at} - ${parsedData[0].created_at}.`);

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
        {"username": "nazwa uzytkownika", "sentiment": "BULLISH lub BEARISH", "quote": "krotki cytat", "url": "link do wpisu lub komentarza ktory zawiera cytat"},
        {"username": "nazwa uzytkownika", "sentiment": "BULLISH lub BEARISH", "quote": "krotki cytat", "url": "link do wpisu lub komentarza ktory zawiera cytat"},
        {"username": "nazwa uzytkownika", "sentiment": "BULLISH lub BEARISH", "quote": "krotki cytat", "url": "link do wpisu lub komentarza ktory zawiera cytat"}
      ]
    }
    
    WAZNE:
    - mostDiscussed: trzy najczesciej omawiane spolki lub aktywa.
    - topQuotes: top 3 krotkich cytatow z najczesciej plusowanych wpisow uzytkownikow.
    - Wszystkie pola sa wymagane.
    
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
            timeout: 60000, // 60 seconds
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
      const entryDate = new Date(entry.created_at.replace(' ', 'T'));
      return entryDate >= twentyFourHoursAgo;
    });

    log(`Got ${recentTomekData.length} Tomek posts between hours: ${recentTomekData[recentTomekData.length -1].created_at} - ${recentTomekData[0].created_at}.`);

    const parsedTomekData = parsePosts(recentTomekData);

    let tomekSentimentResult;

    if (parsedTomekData.length === 0) {
      log("No Tomek posts found in the last 24 hours with #gielda tag.");
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
      - Wszystkie pola sa wymagane.
      
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
              timeout: 60000, // 60 seconds
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

    // --- FETCH NOTIFICATIONS SECTION ---
    
    let mentionsResult;
    try {
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
      log("Successfully authenticated with Wykop");

      const [notificationsResponse1, notificationsResponse2] = await Promise.all([
        fetch('https://wykop.pl/api/v3/notifications/entries?page=1', {
          method: 'GET',
          headers: {
            'accept': 'application/json',
            'Authorization': `Bearer ${wykopToken}`
          }
        }),
        fetch('https://wykop.pl/api/v3/notifications/entries?page=2', {
          method: 'GET',
          headers: {
            'accept': 'application/json',
            'Authorization': `Bearer ${wykopToken}`
          }
        })
      ]);

      const [notificationsJson1, notificationsJson2] = await Promise.all([
        notificationsResponse1.json(),
        notificationsResponse2.json()
      ]);

      const allNotifications = [...notificationsJson1.data, ...notificationsJson2.data];
      const filteredNotifications = allNotifications.filter(notification => {
        const notificationDate = new Date(notification.created_at.replace(' ', 'T'));
        if (notificationDate < twentyFourHoursAgo) return false;
        if (notification.type !== 'new_comment_in_entry' && notification.type !== 'new_entry') return false;
        if (notification.read > 0) return false;
        // if (notification.entry?.author?.username === 'KrachSmieciuchIndex') return false;
        if (!notification.entry?.tags?.some(tag => tag === 'gielda')) return false;
        return true;
      });

      // Fetch full discussion for each unique entry
      const uniqueEntryIds = [...new Set(filteredNotifications.map(n => n.entry.id))];
      log(`Fetching full discussions for ${uniqueEntryIds.length} entries...`);
      
      const commentsResponses = await Promise.all(
        uniqueEntryIds.map(entryId =>
          fetch(`https://wykop.pl/api/v3/entries/${entryId}/comments?page=1&limit=50`, {
            method: 'GET',
            headers: {
              'accept': 'application/json',
              'Authorization': `Bearer ${wykopToken}`
            }
          })
        )
      );

      const commentsData = await Promise.all(commentsResponses.map(r => r.json()));
      
      // Create a map of entry ID to comments
      const entryCommentsMap = {};
      uniqueEntryIds.forEach((entryId, index) => {
        entryCommentsMap[entryId] = commentsData[index].data || [];
      });

      const notificationIds = [];

      // Parse notification entries with full comments
      const parsedNotifications = filteredNotifications.map(notification => {
        const entry = notification.entry;
        const fullComments = entryCommentsMap[entry.id] || [];
        
        // Determine which content triggered the notification
        let questionToAnswer = null;
        if (notification.type === 'new_entry') {
          // The entry itself mentioned the bot
          questionToAnswer = entry.content;
        } else if (notification.type === 'new_comment_in_entry' && notification.comment) {
          // A specific comment mentioned the bot
          questionToAnswer = notification.comment.content;
        }

        notificationIds.push(notification.id);
        
        return {
          questionToAnswer: questionToAnswer,
          post: {
            id: entry.id,
            url: `https://wykop.pl/wpis/${entry.id}`,
            username: entry.author.username,
            created_at: entry.created_at,
            votes: entry.votes.up,
            content: entry.content,
            photo_url: entry.media?.photo?.url || null,
            embed_url: entry.media?.embed?.url || null,
          },
          comments: fullComments.map(comment => parseComment(comment, entry.id))
        };
      });

      log(`Got ${parsedNotifications.length} relevant notifications from the last 24 hours.`);

      if (parsedNotifications.length === 0) {
        log("No relevant notifications found in the last 24 hours.");
        mentionsResult = {
          mentionsReplies: JSON.stringify([])
        };
      } else {
        const mentionsPrompt = `Jestes kontem KrachSmieciuchIndex na wykop.pl. Udziel krotkich odpowiedzi na wpisy/komentarze, w ktorych zostales oznaczony. 
        Odpowiedz tylko na pytania. Jezeli jest ich wiecej niz 5, odpowiedz tylko na 5 najciekawszych.
        Dlugosc odpowiedzi na kazde z pytan (pole "reply") nie moze przekroczyc 300 znakow. Jezeli wpis/komentarz z pytaniem jest dluzszy niz 300 znakow, uzyj streszczenia zamiast cytatu.
        
        UWAGA: Kazdy wpis ma pole "questionToAnswer" - to jest dokladnie ten tekst, na ktory powinienes odpowiedziec. 
        Pole "post.content" zawiera wpis glowny (dla kontekstu), a "comments" zawiera wszystkie komentarze (dla kontekstu).
        Odpowiadaj tylko na tekst z pola "questionToAnswer".
        
        Odpowiedz w nastepujacym formacie JSON:
        {
          "mentionsReplies": [
            {"username": "nazwa uzytkownika", "url": "link do wpisu lub komentarza ktory zawiera pytanie", "post": "cytat lub streszczenie", "reply": "twoja odpowiedz"},
            {"username": "nazwa uzytkownika", "url": "link do wpisu lub komentarza ktory zawiera pytanie", "post": "cytat lub streszczenie", "reply": "twoja odpowiedz"}
          ]
        }
        
        WAZNE:
        - Wszystkie pola (username, url, post, reply) sa wymagane w kazdym obiekcie.
        - Jezeli nie ma pytan do odpowiedzi, zwroc pusta tablice w polu mentionsReplies.
        - Odpowiadaj TYLKO na tekst z pola questionToAnswer, ale uzyj pola post i comments dla kontekstu.
        
        Wpisy: ${JSON.stringify(parsedNotifications)}`;

        const mentionsSchema = {
          mentionsReplies: { type: 'array-of-objects', requiredFields: ['username', 'url', 'post', 'reply'] }
        };

        await retryWithBackoff(async () => {
          const mentionsResponse = await ai.models.generateContent({
            model: model,
            contents: mentionsPrompt,
            config: {
              httpOptions: {
                timeout: 60000, // 60 seconds
              },
              systemInstruction: systemInstruction,
              tools: [{urlContext: {}}],
            },
          });

          log("Mentions response: " + JSON.stringify(mentionsResponse.text));

          try {
            mentionsResult = cleanJsonResponse(mentionsResponse.text);
          } catch (parseError) {
            error("Failed to parse mentions response as JSON: " + parseError.message);
            error("Raw response: " + mentionsResponse.text);
            throw new Error("Mentions returned invalid JSON: " + parseError.message);
          }

          // Validate schema
          const schemaErrors = validateSchema(mentionsResult, mentionsSchema);
          if (schemaErrors.length > 0) {
            error("Mentions schema validation failed: " + schemaErrors.join(', '));
            error("Raw response: " + mentionsResponse.text);
            throw new Error("Mentions response doesn't match expected schema: " + schemaErrors.join(', '));
          }
        });
      }

      // Ensure mentionsReplies is a string
      if (Array.isArray(mentionsResult.mentionsReplies)) {
        mentionsResult.mentionsReplies = JSON.stringify(mentionsResult.mentionsReplies);
      }
      
      // Mark notifications as read
      if (notificationIds.length > 0) {
        log(`Marking ${notificationIds.length} notifications as read...`);
        notificationIds.forEach(notificationId => {
          log(`Marking notification ID as read: ${notificationId}`);
          fetch(`https://wykop.pl/api/v3/notifications/entries/${notificationId}`, {
            method: 'PUT',
            headers: {
              'accept': 'application/json',
              'Authorization': `Bearer ${wykopToken}`
            }
          });
        });
      }
    } catch (notificationsError) {
      error("Failed to fetch or process notifications: " + notificationsError.message);
      mentionsResult = {
        mentionsReplies: JSON.stringify([])
      };
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
          mentionsReplies: mentionsResult.mentionsReplies
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
