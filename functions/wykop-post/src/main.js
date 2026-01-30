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
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    let model = 'gemini-2.5-flash';
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

    // Retry helper with exponential backoff
    const retryWithBackoff = async (fn, maxAttempts = 3, delayMs = 30000) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // Change model to gemini-2.5-flash-lite on 3rd attempt
          if (attempt === 3) {
            model = 'gemini-2.5-flash-lite';
            log('Switching to gemini-2.5-flash-lite for final attempt');
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

    const nowPoland = new Date().toLocaleString('en-US', { timeZone: 'Europe/Warsaw' });
    const currentTime = new Date(nowPoland);
    const oneHourAgo = new Date(currentTime.getTime() - 60 * 60 * 1000);

    // Helper function to parse comments
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
      const notificationDate = new Date(notification.created_at.replace(' ', 'T'));
      if (notificationDate < oneHourAgo) return false;
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

    log(`Got ${parsedNotifications.length} unread notifications from the last 1 hour: ${JSON.stringify(parsedNotifications)}`);

    // --- GENERATE MENTIONS RESPONSES SECTION ---

    let mentionsResult;

    if (parsedNotifications.length === 0) {
      mentionsResult = [];
    } else {
      const mentionsPrompt = `Jestes kontem KrachSmieciuchIndex na wykop.pl. Udziel krotkich odpowiedzi na wpisy/komentarze, w ktorych zostales oznaczony. Odpowiadaj tylko na pytania.
      Analizuj tylko tekst z pola questionToAnswer. Udziel konkretnej odpowiedzi na zadane pytanie lub poruszony temat. Uwzglednij kontekst z calego wpisu (pole post) oraz komentarzy (pole comments), aby dostarczyc precyzyjna i trafna odpowiedz.
      Dlugosc odpowiedzi na kazde z pytan (pole "reply") nie moze przekroczyc 800 znakow.
      
      Odpowiedz w nastepujacym formacie JSON (flat array):
      [
        {"id": "skopiuj wartosc z post.id", "username": "nazwa uzytkownika", "url": "link do wpisu lub komentarza ktory zawiera pytanie", "post": "tekst z pola questionToAnswer (jezeli jest dluzszy niz 300 znakow, uzyj streszczenia)", "reply": "twoja odpowiedz"},
        {"id": "skopiuj wartosc z post.id", "username": "nazwa uzytkownika", "url": "link do wpisu lub komentarza ktory zawiera pytanie", "post": "tekst z pola questionToAnswer (jezeli jest dluzszy niz 300 znakow, uzyj streszczenia)", "reply": "twoja odpowiedz"}
      ]
      
      WAZNE:
      - Pole "id" MUSI byc rowne wartosci "post.id" z danych wejsciowych (np. jesli post.id to 12345, to id w odpowiedzi to 12345).
      - Wszystkie pola (id, username, url, post, reply) sa wymagane w kazdym obiekcie.
      - Jezeli nie ma pytan do odpowiedzi, zwroc pusta tablice [].
      - Odpowiadaj TYLKO na tekst z pola questionToAnswer, ale uzyj pola post i comments dla kontekstu.
      
      Wpisy: ${JSON.stringify(parsedNotifications)}`;

      const mentionsSchema = { type: 'array-of-objects', requiredFields: ['id', 'username', 'url', 'post', 'reply'] };

      await retryWithBackoff(async () => {
        const mentionsResponse = await ai.models.generateContent({
          model: model,
          contents: mentionsPrompt,
          config: {
            httpOptions: {
              timeout: 90000, // 90 seconds
            },
            systemInstruction: systemInstruction,
            tools: [
              { googleSearch: {} },
              { urlContext: {} }
            ]
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
        log(`Posting a reply to ${replyObj.url}`);

          const postContent = `@${replyObj.username} ${replyObj.reply}`;

          const postResponse = await fetch(`https://wykop.pl/api/v3/entries/${replyObj.id}/comments`, {
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
      notificationIds.forEach(notificationId => {
        fetch(`https://wykop.pl/api/v3/notifications/entries/${notificationId}`, {
          method: 'PUT',
          headers: {
            'accept': 'application/json',
            'Authorization': `Bearer ${wykopToken}`
          }
        });

        log(`Marked notification ID as read: ${notificationId}`);
      });
    };

    return res.empty();
  } catch(err) {
    error("Error: " + err.message);
    return res.json({
      error: err.message
    }, 500);
  }
};
