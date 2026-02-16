import * as sdk from 'node-appwrite';
import { GoogleGenAI } from '@google/genai';

export default async ({ req, res, log, error }) => {
  try {
    // Initialize Appwrite client
    const client = new sdk.Client()
      .setEndpoint('https://fra.cloud.appwrite.io/v1')
      .setProject('wykopindex')
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new sdk.Databases(client);

    // Initialize Gemini AI
    const primaryAi = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
    
    const backupAi = new GoogleGenAI({
      apiKey: process.env.GEMINI_BACKUP_API_KEY,
    });

    let ai = primaryAi;

    let model = 'gemini-2.5-flash';
    const systemInstruction = `You are KrachSmieciuchIndex, a helpful assistant that responds to questions about stock markets, investing, and economics on Wykop, a Polish social media platform.
    
    BEHAVIORAL RULES:
    - Keep each reply under 800 characters.
    - Use a mildly ironic and sarcastic tone characteristic of Wykop but only where appropriate based on the content you're responding to. If the question is straightforward and serious, respond in a direct manner.
    - Provide specific, concrete answers - avoid generalities and platitudes.
    - If a question is about the specific stocks or your recommendations, do not provide generic advice. Research the stocks, recent news, and provide a data-driven answer based on that.
    - If you can't access an attachment or URL, say "Nie mogę otworzyć załącznika, ale na podstawie tekstu mogę powiedzieć, że..." and provide an answer based on the text alone.
    - If you can't answer a question or it doesn't warrant a response, ignore it and do not include it in the output.
    
    CRITICAL: You MUST respond with ONLY raw JSON. DO NOT wrap your response in markdown code blocks. DO NOT add any text before or after the JSON. Your entire response must be valid JSON that can be directly parsed.
    `;

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

    // Retry helper with exponential backoff
    const retryWithBackoff = async (fn, maxAttempts = 4, delayMs = 30000) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const backupModel = 'gemini-3-flash-preview';

          switch (attempt) {
            case 1:
              log(`Attempt 1: Using primary AI instance and ${model} model`);
              break;
            case 2:
              log(`Attempt 2: Using backup AI instance and ${model} model`);
              ai = backupAi;
              break;
            case 3:
              log(`Attempt 3: Using primary AI instance and ${backupModel} model`);
              ai = primaryAi;
              model = backupModel;
              break;
            case 4:
              log(`Attempt 4: Final attempt with backup AI instance and ${backupModel} model`);
              ai = backupAi;
              model = backupModel;
              break;
          }

          const tools = [{ urlContext: {} }];

          // googleSearch is not supported in gemini-3-flash-preview free tier
          if (model === 'gemini-2.5-flash') {
            tools.push({ googleSearch: {} });
          }

          return await fn(tools);
        } catch (err) {
          if (attempt === maxAttempts) {
            throw err;
          }
          
          log(`Attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    };

    // Get current UTC time and calculate Poland offset (UTC+1 or UTC+2 depending on DST)
    const nowUTC = new Date();
    const nowPolandStr = nowUTC.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' });
    const polandOffset = new Date(nowPolandStr).getTime() - nowUTC.getTime();
    const oneHourAgo = new Date(nowUTC.getTime() - 60 * 60 * 1000);

    // Helper function to strip query parameters from URL
    const stripQueryParams = (url) => url ? url.split('?')[0] : null;

    // Helper function to parse comments
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

    // --- AUTHENTICATION SECTION ---

    log("Authenticating with Wykop API using refresh token...");
    const wykopAuthResponse = await fetch('https://wykop.pl/api/v3/refresh-token', {
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

    const wykopAuthResponseJson = await wykopAuthResponse.json();
    const wykopToken = wykopAuthResponseJson.data.token;
    log("Successfully authenticated with Wykop using refresh token");

    // --- FETCH NOTIFICATIONS SECTION ---
    
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

    log(`Fetched ${allNotifications.length} notifications from Wykop. Filtering...`);

    const filteredNotifications = allNotifications.filter(notification => {
      // Wykop API returns Poland time, parse as UTC then subtract Poland offset
      const notificationDate = new Date(notification.created_at.replace(' ', 'T') + 'Z');
      const notificationTimeUTC = notificationDate.getTime() - polandOffset;
      if (notificationTimeUTC < oneHourAgo.getTime()) return false;
      if (notification.type !== 'new_comment_in_entry' && notification.type !== 'new_entry') return false;
      if (notification.read > 0) return false;
      // if (notification.entry?.author?.username === 'KrachSmieciuchIndex') return false;
      if (!notification.entry?.tags?.some(tag => tag === 'gielda')) return false;
      return true;
    });

    // Fetch full discussion for each unique entry
    const uniqueEntryIds = [...new Set(filteredNotifications.map(n => n.entry.id))];
    
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
      let replyToUsername = null;
      
      if (notification.type === 'new_entry') {
        // The entry itself mentioned the bot
        questionToAnswer = entry.content;
        replyToUsername = entry.author.username;
      } else if (notification.type === 'new_comment_in_entry' && notification.comment) {
        // A specific comment mentioned the bot
        questionToAnswer = notification.comment.content;
        replyToUsername = notification.comment.author.username;
      }

      notificationIds.push(notification.id);
      
      return {
        questionToAnswer: questionToAnswer,
        replyToUsername: replyToUsername,
        post: {
          id: entry.id,
          url: `https://wykop.pl/wpis/${entry.id}`,
          username: entry.author.username,
          created_at: entry.created_at,
          votes: entry.votes.up,
          content: entry.content,
          photo_url: stripQueryParams(entry.media?.photo?.url),
          embed_url: stripQueryParams(entry.media?.embed?.url),
        },
        comments: fullComments.map(comment => parseComment(comment, entry.id))
      };
    });

    log(`Got ${parsedNotifications.length} unread notifications from the last hour: ${JSON.stringify(parsedNotifications.map(n => 
      ({ entryUrl: n.post.url, questionToAnswer: n.questionToAnswer })
    ))}`);

    // --- GENERATE MENTIONS RESPONSES SECTION ---

    let mentionsResult;

    if (parsedNotifications.length === 0) {
      mentionsResult = [];
    } else {
      const mentionsPrompt = `Udziel odpowiedzi na wpisy/komentarze, w ktorych zostales oznaczony. Odpowiadaj szczerze i konkretnie, bazujac na danych i faktach, ale jezeli wpis jest ironiczny lub sarkastyczny, odpowiedz w podobnym tonie.
      Odpowiadaj tylko na tekst z pola questionToAnswer, ale uwzglednij kontekst z calego wpisu (pole post) oraz komentarzy (pole comments), aby dostarczyc precyzyjna odpowiedz.
      Jezeli wpis lub komentarz zawiera zalacznik (pole photo_url lub embed_url), otworz go i uwzglednij jego tresc w swojej odpowiedzi.
      
      Odpowiedz w nastepujacym formacie JSON (flat array):
      [
        {"postId": "skopiuj wartosc z post.id", "username": "skopiuj wartosc z replyToUsername", "url": "link do wpisu lub komentarza ktory zawiera pytanie", "post": "tekst z pola questionToAnswer (jezeli jest dluzszy niz 300 znakow, uzyj streszczenia)", "reply": "twoja odpowiedz"},
        {"postId": "skopiuj wartosc z post.id", "username": "skopiuj wartosc z replyToUsername", "url": "link do wpisu lub komentarza ktory zawiera pytanie", "post": "tekst z pola questionToAnswer (jezeli jest dluzszy niz 300 znakow, uzyj streszczenia)", "reply": "twoja odpowiedz"}
      ]
      
      WAZNE:
      - Pole "postId" MUSI byc rowne wartosci "post.id" z danych wejsciowych - to jest ID wpisu (entry), NIE komentarza.
      - Pole "username" MUSI byc rowne wartosci "replyToUsername" z danych wejsciowych.
      - Odpowiadaj TYLKO na tekst z pola questionToAnswer, ale uzyj pola post i comments dla kontekstu.
      - Dlugosc odpowiedzi na kazde z pytan (pole "reply") nie moze przekroczyc 800 znakow.
      - Wszystkie pola (postId, username, url, post, reply) sa wymagane w kazdym obiekcie.
      - Jezeli nie ma pytan do odpowiedzi, zwroc pusta tablice [].
      
      Wpisy: ${JSON.stringify(parsedNotifications)}`;

      const mentionsSchema = { type: 'array-of-objects', requiredFields: ['postId', 'username', 'url', 'post', 'reply'] };

      await retryWithBackoff(async (tools) => {
        log(`Tools enabled: ${JSON.stringify(tools.map(t => Object.keys(t)[0]))}`);

        const mentionsResponse = await ai.models.generateContent({
          model: model,
          contents: mentionsPrompt,
          config: {
            httpOptions: {
              timeout: 120000, // 120 seconds
            },
            systemInstruction: systemInstruction,
            tools: tools
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
        if (!Array.isArray(mentionsResult)) {
          throw new Error("Mentions response should be an array");
        }
        
        // Validate each object in the array
        const errors = [];
        const requiredFields = mentionsSchema.requiredFields || [];
        mentionsResult.forEach((item, index) => {
          if (typeof item !== 'object' || item === null) {
            errors.push(`Item ${index} should be an object`);
          } else {
            requiredFields.forEach(field => {
              if (!(field in item)) {
                errors.push(`Item ${index} is missing required field: ${field}`);
              }
            });
          }
        });
        
        if (errors.length > 0) {
          error("Mentions schema validation failed: " + errors.join(', '));
          error("Raw response: " + mentionsResponse.text);
          throw new Error("Mentions response doesn't match expected schema: " + errors.join(', '));
        }
      });
    }

    // --- POST TO WYKOP AND SAVE TO DATABASE SECTION ---

    for (const replyObj of mentionsResult) {
      try {
        log(`Posting a reply to ${replyObj.postId} for user ${replyObj.username}`);

          const postContent = `@${replyObj.username} ${replyObj.reply}`;

          const postResponse = await fetch(`https://wykop.pl/api/v3/entries/${replyObj.postId}/comments`, {
            method: 'POST',
            headers: {
              'accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${wykopToken}`
            },
            body: JSON.stringify({
              data: {
                content: postContent,
                adult: false
              }
            })
          });

          log(`Post response status: ${postResponse.status}`);
          
          if (!postResponse.ok) {
            const errorText = await postResponse.text();
            throw new Error(`Failed to post to Wykop: ${postResponse.status} ${errorText}`);
          }

          const postResult = await postResponse.json();
          log(`Successfully posted to Wykop, entry ID: ${postResult.data.id}`);

          
          try {
            log(`Saving reply to database`);

            const dbResult = await databases.createDocument(
              '69617178003ac8ef4fba',
              'replies',
              sdk.ID.unique(),
              {
                postUrl: replyObj.url,
                question: replyObj.post,
                reply: replyObj.reply,
                username: replyObj.username
              }
            );
            log(`Database entry added: ${dbResult.$id}`);
          } catch (dbError) {
            error(`Failed to save reply to database: ${dbError.message}`);
          }
        } catch (postError) {
          error(`Failed to process reply for ${replyObj.username}: ${postError.message}`);
      }
    }
    
    // Mark notifications as read
    if (notificationIds.length > 0) {
      log(`Marking ${notificationIds.length} notifications as read...`);
      await Promise.all(notificationIds.map(async notificationId => {
        try {
          const markReadResponse = await fetch(`https://wykop.pl/api/v3/notifications/entries/${notificationId}`, {
            method: 'PUT',
            headers: {
              'accept': 'application/json',
              'Authorization': `Bearer ${wykopToken}`
            }
          });
          
          if (markReadResponse.ok) {
            log(`Marked notification ID as read: ${notificationId}`);
          } else {
            error(`Failed to mark notification ${notificationId} as read: ${markReadResponse.status}`);
          }
        } catch (markError) {
          error(`Error marking notification ${notificationId} as read: ${markError.message}`);
        }
      }));
    }

    return res.empty();
  } catch(err) {
    error("Error: " + err.message);
    return res.json({
      error: err.message
    }, 500);
  }
};
