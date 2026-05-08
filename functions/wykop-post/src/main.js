import * as sdk from 'node-appwrite';
import { GoogleGenAI } from '@google/genai';
import { cleanJsonResponse, parseComment, formatEps, formatRevenue } from './utils.js';

// Appwrite resource IDs
const DATABASE_ID = '69617178003ac8ef4fba';
const REPLIES_COLLECTION = 'replies';
const SENTIMENT_COLLECTION = 'sentiment';
const SUBSCRIBERS_COLLECTION = 'subscribers';
const EARNINGS_COLLECTION = 'earnings';

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
    - DO NOT respond to comments that say "@KrachSmieciuchIndex nie wołaj" - these are instructions from users to not be notified about the future updates, so you should ignore them.
    
    CRITICAL: You MUST respond with ONLY raw JSON. DO NOT wrap your response in markdown code blocks. DO NOT add any text before or after the JSON. Your entire response must be valid JSON that can be directly parsed.
    `;

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

    const supportedImageMimeTypes = new Set([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/heic',
      'image/heif',
    ]);

    const isYouTubeUrl = (url) => {
      if (!url) return false;
      try {
        const { hostname } = new URL(url);
        const host = hostname.toLowerCase();
        return (
          host === 'youtu.be' ||
          host.endsWith('.youtu.be') ||
          host === 'youtube.com' ||
          host.endsWith('.youtube.com') ||
          host === 'youtube-nocookie.com' ||
          host.endsWith('.youtube-nocookie.com')
        );
      } catch {
        return false;
      }
    };

    const buildMediaAttachmentParts = async (
      notifications,
      maxImages = 8,
      maxTotalBytes = 18 * 1024 * 1024,
      maxYouTubeEmbeds = 4
    ) => {
      const imageUrls = [];
      const seenImageUrls = new Set();
      const youTubeUrls = [];
      const seenYouTubeUrls = new Set();
      const nonYouTubeEmbedUrls = [];
      const seenNonYouTubeEmbedUrls = new Set();

      const addImageUrl = (url) => {
        if (!url || seenImageUrls.has(url)) return;
        seenImageUrls.add(url);
        imageUrls.push(url);
      };

      const addEmbedUrl = (url) => {
        if (!url) return;
        if (isYouTubeUrl(url)) {
          if (seenYouTubeUrls.has(url)) return;
          seenYouTubeUrls.add(url);
          youTubeUrls.push(url);
          return;
        }

        if (seenNonYouTubeEmbedUrls.has(url)) return;
        seenNonYouTubeEmbedUrls.add(url);
        nonYouTubeEmbedUrls.push(url);
      };

      for (const item of notifications) {
        addImageUrl(item.post?.photo_url);
        addEmbedUrl(item.post?.embed_url);
        for (const comment of item.comments || []) {
          addImageUrl(comment.photo_url);
          addEmbedUrl(comment.embed_url);
        }
      }

      const imageParts = [];
      const includedImageUrls = [];
      let totalBytes = 0;

      for (const imageUrl of imageUrls) {
        if (imageParts.length >= maxImages) break;

        try {
          const imageResponse = await fetch(imageUrl);
          if (!imageResponse.ok) {
            log(`Skipping image attachment (fetch failed): ${imageUrl} (${imageResponse.status})`);
            continue;
          }

          const mimeTypeHeader = imageResponse.headers.get('content-type') || '';
          const mimeType = mimeTypeHeader.split(';')[0].trim().toLowerCase();
          if (!supportedImageMimeTypes.has(mimeType)) {
            log(`Skipping attachment with unsupported mime type (${mimeType || 'unknown'}): ${imageUrl}`);
            continue;
          }

          const imageArrayBuffer = await imageResponse.arrayBuffer();
          const imageSize = imageArrayBuffer.byteLength;
          if (totalBytes + imageSize > maxTotalBytes) {
            log(`Skipping image attachment due to request size budget: ${imageUrl}`);
            continue;
          }

          imageParts.push({
            inlineData: {
              mimeType,
              data: Buffer.from(imageArrayBuffer).toString('base64'),
            },
          });
          includedImageUrls.push(imageUrl);
          totalBytes += imageSize;
        } catch (imageFetchError) {
          log(`Skipping image attachment due to fetch error: ${imageUrl} (${imageFetchError.message})`);
        }
      }

      const includedYouTubeUrls = youTubeUrls.slice(0, maxYouTubeEmbeds);
      if (youTubeUrls.length > maxYouTubeEmbeds) {
        log(`Skipping ${youTubeUrls.length - maxYouTubeEmbeds} YouTube embeds due to cap (${maxYouTubeEmbeds})`);
      }

      const videoParts = includedYouTubeUrls.map((url) => ({
        fileData: { fileUri: url },
      }));

      return {
        imageParts,
        includedImageUrls,
        videoParts,
        includedYouTubeUrls,
        nonYouTubeEmbedUrls,
      };
    };

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

    if (!notificationsResponse1.ok || !notificationsResponse2.ok) {
      throw new Error(`Wykop notifications fetch failed: ${notificationsResponse1.status} / ${notificationsResponse2.status}`);
    }

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
          photo_url: entry.media?.photo?.url || null,
          embed_url: entry.media?.embed?.url || null,
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
      const mentionsPrompt = `Udziel odpowiedzi na wpisy/komentarze, w ktorych zostales oznaczony. Jezeli wpis nie zawiera pytania lub prosby, zignoruj go i nie umieszczaj w odpowiedzi.
      Odpowiadaj szczerze i konkretnie, bazujac na danych i faktach, ale jezeli wpis jest ironiczny lub sarkastyczny, odpowiedz w podobnym tonie.
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
      - Szczur = XTB; Olejorz = Orlen.
      
      Wpisy: ${JSON.stringify(parsedNotifications)}`;

      const mentionsSchema = { requiredFields: ['postId', 'username', 'url', 'post', 'reply'] };

      await retryWithBackoff(async (tools) => {
        log(`Tools enabled: ${JSON.stringify(tools.map(t => Object.keys(t)[0]))}`);

        const {
          imageParts,
          includedImageUrls,
          videoParts,
          includedYouTubeUrls,
          nonYouTubeEmbedUrls,
        } = await buildMediaAttachmentParts(parsedNotifications);
        const mentionsContents = [...imageParts, ...videoParts];
        const mediaInfoBlocks = [];

        if (includedImageUrls.length > 0) {
          log(`Included ${includedImageUrls.length} image attachments for multimodal analysis`);
          mediaInfoBlocks.push(`Dolaczone obrazy (w kolejnosci):\n${includedImageUrls.map((url, index) => `${index + 1}. ${url}`).join('\n')}`);
        }

        if (includedYouTubeUrls.length > 0) {
          log(`Included ${includedYouTubeUrls.length} YouTube embeds for multimodal video analysis`);
          mediaInfoBlocks.push(`Dolaczone filmy YouTube (w kolejnosci):\n${includedYouTubeUrls.map((url, index) => `${index + 1}. ${url}`).join('\n')}`);
        }

        if (nonYouTubeEmbedUrls.length > 0) {
          log(`Found ${nonYouTubeEmbedUrls.length} non-YouTube embed URLs (urlContext fallback)`);
          mediaInfoBlocks.push(`Dodatkowe linki osadzone (sprobuj odczytac przez urlContext):\n${nonYouTubeEmbedUrls.map((url, index) => `${index + 1}. ${url}`).join('\n')}`);
        }

        if (mediaInfoBlocks.length > 0) {
          mentionsContents.push({ text: mediaInfoBlocks.join('\n\n') });
        } else {
          log('No supported image or YouTube attachments were included in multimodal request');
        }

        mentionsContents.push({ text: mentionsPrompt });

        const mentionsResponse = await ai.models.generateContent({
          model: model,
          contents: mentionsContents,
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
          log(`Posting a reply in entry ID ${replyObj.postId} for user ${replyObj.username}`);

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

          if (!postResponse.ok) {
            const errorText = await postResponse.text();
            throw new Error(`Failed to post to Wykop: ${postResponse.status} ${errorText}`);
          }

          const postResult = await postResponse.json();
          log(`Successfully posted to Wykop, comment ID: ${postResult.data.id}`);

          try {
            log(`Saving reply to database`);

            const dbResult = await databases.createDocument(
              DATABASE_ID,
              REPLIES_COLLECTION,
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
    
    // --- SET SUBSCRIBERS SECTION ---

    try {
      const latestSentiment = await databases.listDocuments(
        DATABASE_ID,
        SENTIMENT_COLLECTION,
        [
          sdk.Query.orderDesc('$createdAt'),
          sdk.Query.limit(1)
        ]
      );

      const latestEntryId = latestSentiment.documents[0]?.entryId;
      log(`Latest sentiment entryId: ${latestEntryId}`);

      if (latestEntryId) {
        const subEntryCommentsResponse = await fetch(`https://wykop.pl/api/v3/entries/${latestEntryId}/comments?page=1&limit=50`, {
          method: 'GET',
          headers: {
            'accept': 'application/json',
            'Authorization': `Bearer ${wykopToken}`
          }
        });

        if (!subEntryCommentsResponse.ok) {
          throw new Error(`Failed to fetch entry comments: ${subEntryCommentsResponse.status} ${await subEntryCommentsResponse.text()}`);
        }

        const subEntryCommentsJson = await subEntryCommentsResponse.json();
        const subEntryComments = subEntryCommentsJson.data || [];

        const subscriptionComment = subEntryComments.find(comment =>
          comment.author?.username === 'KrachSmieciuchIndex' &&
          comment.content?.startsWith('Zaplusuj ten komentarz jeżeli chcesz być wołany do przyszłych wpisów')
        );

        if (subscriptionComment) {
          const votesResponse = await fetch(`https://wykop.pl/api/v3/entries/${latestEntryId}/comments/${subscriptionComment.id}/votes`, {
            method: 'GET',
            headers: {
              'accept': 'application/json',
              'Authorization': `Bearer ${wykopToken}`
            }
          });

          if (!votesResponse.ok) {
            throw new Error(`Failed to fetch comment votes: ${votesResponse.status} ${await votesResponse.text()}`);
          }

          const votesJson = await votesResponse.json();
          const voters = votesJson.data || [];

          for (const voter of voters) {
            const voterUsername = voter.username;

            try {
              try {
                await databases.getDocument(DATABASE_ID, SUBSCRIBERS_COLLECTION, voterUsername);
                log(`Subscriber already exists (skipping): ${voterUsername}`);
              } catch (notFoundError) {
                await databases.createDocument(
                  DATABASE_ID,
                  SUBSCRIBERS_COLLECTION,
                  voterUsername,
                  { username: voterUsername }
                );
                log(`Added subscriber: ${voterUsername}`);
              }
            } catch (subscriberError) {
              error(`Failed to add subscriber ${voterUsername}: ${subscriberError.message}`);
            }
          }
        } else {
          log('Subscription comment not found in entry');
        }

        const unsubscribeComments = subEntryComments.filter(comment =>
          comment.author.username !== 'KrachSmieciuchIndex' &&
          /@KrachSmieciuchIndex: nie wo[łl]aj/i.test(comment.content)
        );

        log(`Found ${unsubscribeComments.length} unsubscribe comments`);

        for (const comment of unsubscribeComments) {
          const unsubUsername = comment.author.username;

          try {
            await databases.deleteDocument(DATABASE_ID, SUBSCRIBERS_COLLECTION, unsubUsername);
            log(`Unsubscribed: ${unsubUsername}`);
          } catch (notFoundError) {
            log(`Unsubscribe request from non-subscriber: ${unsubUsername}`);
          }
        }
      }
    } catch (subscribersError) {
      error(`Failed to process subscribers: ${subscribersError.message}`);
    }

    // --- EARNINGS CALENDAR SECTION ---

    try {
      // Use ET date to identify the trading day — US market close is 16:30 ET.
      // The date string is also used as the Nasdaq API parameter, so it must reflect the ET calendar day.
      const etFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      });
      const etFormatted = etFormatter.format(nowUTC); // "YYYY-MM-DD, HH:mm"
      const [todayET, etTime] = etFormatted.split(', ');
      const [etHour, etMinute] = etTime.split(':').map(Number);

      const minutesSinceClose = (etHour * 60 + etMinute) - (16 * 60 + 30);
      const isAfterClose = minutesSinceClose >= 0;
      const isWithinRetryWindow = isAfterClose && minutesSinceClose < 60;

      // Preview window: 9:00–10:59 UTC (5:00–6:59 ET in EDT)
      const utcHour = nowUTC.getUTCHours();
      const isPreviewTime = utcHour >= 9 && utcHour < 11;

      log(`ET date: ${todayET}, ET time: ${etHour}:${String(etMinute).padStart(2, '0')}, isAfterClose: ${isAfterClose}, minutesSinceClose: ${minutesSinceClose}, isWithinRetryWindow: ${isWithinRetryWindow}, isPreviewTime: ${isPreviewTime}`);

      // Align the DB query boundary to midnight of the ET trading day, not UTC midnight.
      // Without this, after UTC midnight (still same ET day), the query finds no record and creates a duplicate.
      const minutesSinceMidnightET = etHour * 60 + etMinute;
      const startOfTradingDayUTC = new Date(nowUTC.getTime() - minutesSinceMidnightET * 60 * 1000);

      // Helper: fetch today's top-10 earnings by market cap from Nasdaq, then enrich with Finnhub
      const fetchEarnings = async () => {
          // Step 1: Nasdaq — get all companies reporting today, filter and rank by market cap
          const nasdaqResponse = await fetch(
            `https://api.nasdaq.com/api/calendar/earnings?date=${todayET}`,
            { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
          );
          if (!nasdaqResponse.ok) {
            throw new Error(`Nasdaq earnings fetch failed: ${nasdaqResponse.status} ${await nasdaqResponse.text()}`);
          }
          const nasdaqJson = await nasdaqResponse.json();
          const rows = nasdaqJson?.data?.rows ?? [];
          const parseNum = (str) => {
            if (!str || str === '-' || str === 'N/A') return null;
            const s = String(str).replace(/[$,]/g, '');
            const negative = s.startsWith('(') && s.endsWith(')');
            const n = parseFloat(negative ? s.slice(1, -1) : s);
            return isNaN(n) ? null : (negative ? -n : n);
          };
          const seenNames = new Set();
          const candidates = rows
            .map(r => ({ symbol: r.symbol, name: r.name || null, marketCap: parseNum(r.marketCap), time: r.time || null }))
            .filter(r => r.marketCap != null && r.marketCap >= 10_000_000_000)
            .sort((a, b) => b.marketCap - a.marketCap)
            .filter(r => {
              const key = r.name?.trim().toLowerCase() ?? r.symbol;
              if (seenNames.has(key)) return false;
              seenNames.add(key);
              return true;
            })
            .slice(0, 25); // cap Finnhub calls well within the 60/min free tier limit

          if (candidates.length === 0) return [];

          // Step 2: Finnhub — fetch EPS data for each company in parallel
          const finnhubResults = await Promise.all(
            candidates.map(async (company) => {
              try {
                const url = `https://finnhub.io/api/v1/calendar/earnings?from=${todayET}&to=${todayET}&symbol=${company.symbol}&token=${process.env.FINNHUB_API_KEY}`;
                const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!res.ok) return null;
                const json = await res.json();
                return json?.earningsCalendar?.[0] ?? null;
              } catch {
                return null;
              }
            })
          );

          return candidates.map((company, i) => {
            const fh = finnhubResults[i];
            const epsActual = fh?.epsActual ?? null;
            const epsEstimated = fh?.epsEstimate ?? null;
            const surprise = (epsActual !== null && epsEstimated !== null && epsEstimated !== 0)
              ? (epsActual - epsEstimated) / Math.abs(epsEstimated) * 100
              : null;
            return {
              symbol: company.symbol,
              name: company.name,
              date: todayET,
              marketCap: company.marketCap,
              time: company.time,
              epsEstimated,
              epsActual,
              surprise,
              revenueActual: fh?.revenueActual ?? null,
            };
          }).filter(r => r.epsEstimated != null);
      };

      // --- MORNING PREVIEW (9:00–10:59 UTC) ---
      if (isPreviewTime) {
        const existingDocs = (await databases.listDocuments(
          DATABASE_ID,
          EARNINGS_COLLECTION,
          [
            sdk.Query.greaterThanEqual('$createdAt', startOfTradingDayUTC.toISOString()),
            sdk.Query.orderDesc('$createdAt'),
            sdk.Query.limit(1)
          ]
        )).documents;

        if (existingDocs.length > 0) {
          log(`Preview already handled for ${todayET}, skipping.`);
        } else {
          log(`Posting earnings preview for ${todayET}...`);
          const earningsData = await fetchEarnings();

          if (earningsData.length === 0) {
            log(`No earnings data for preview on ${todayET}`);
          } else {
            const top10 = earningsData.slice(0, 10);
            await databases.createDocument(
              DATABASE_ID,
              EARNINGS_COLLECTION,
              sdk.ID.unique(),
              { earnings: JSON.stringify(top10), posted: false }
            );
            log(`Saved earnings record for ${todayET} with ${top10.length} entries (${earningsData.length} total candidates)`);

            const previewLines = top10.map(entry => {
              const name = entry.name ? ` (${entry.name})` : '';
              const timing = entry.time === 'time-pre-market' ? '🌅'
                : entry.time === 'time-after-hours' ? '🌙'
                : '';
              return `[${entry.symbol}](https://finance.yahoo.com/quote/${entry.symbol})${name}${timing ? ' — ' + timing : ''}`;
            });

            const formattedDate = nowUTC.toLocaleString('pl-PL', {
              year: 'numeric', month: '2-digit', day: '2-digit',
              timeZone: 'Europe/Warsaw'
            });

            const previewContent = `**Dzisiaj raportują - ${formattedDate}** (top 10 według kapitalizacji, > $10B, USA)
🌅  = przed otwarciem
🌙 = po zamknięciu

${previewLines.join('\n')}

Wyniki pojawią się na tagu po zamknięciu sesji.
Wszystkie wyniki z ostatnich 90 dni dostępne [na stronie](https://wykop-index.appwrite.network/#earnings).

#gielda #wykopindex #krachsmieciuchindex`;

            const previewResponse = await fetch('https://wykop.pl/api/v3/entries', {
              method: 'POST',
              headers: {
                'accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${wykopToken}`
              },
              body: JSON.stringify({ data: { content: previewContent, adult: false } })
            });

            if (!previewResponse.ok) {
              const errorText = await previewResponse.text();
              log(`Failed to post preview: ${previewResponse.status} ${errorText}`);
            } else {
              log(`Preview posted for ${todayET}`);
            }
          }
        }
      }

      // --- EVENING RESULTS (after 16:30 ET) ---
      if (isAfterClose) {
        const existingDocs = (await databases.listDocuments(
          DATABASE_ID,
          EARNINGS_COLLECTION,
          [
            sdk.Query.greaterThanEqual('$createdAt', startOfTradingDayUTC.toISOString()),
            sdk.Query.orderDesc('$createdAt'),
            sdk.Query.limit(1)
          ]
        )).documents;

        let currentDoc = existingDocs[0] || null;

        if (!currentDoc) {
          // No morning preview ran — fetch now
          log(`No earnings record for ${todayET}, fetching from Nasdaq + Finnhub...`);
          const earningsData = await fetchEarnings();

          if (earningsData.length === 0) {
            log(`No earnings data returned from Nasdaq + Finnhub for ${todayET}`);
          } else {
            const top10fallback = earningsData.slice(0, 10);
            currentDoc = await databases.createDocument(
              DATABASE_ID,
              EARNINGS_COLLECTION,
              sdk.ID.unique(),
              { earnings: JSON.stringify(top10fallback), posted: false }
            );
            log(`Saved earnings record for ${todayET} with ${top10fallback.length} entries`);
          }
        }

        if (currentDoc) {
          if (currentDoc.posted === true) {
            log(`Earnings for ${todayET} already posted, skipping.`);
          } else {
            let currentData = JSON.parse(currentDoc.earnings);
            const hasActualEPS = (entry) => entry.epsActual !== null;

            if (currentData.some(entry => !hasActualEPS(entry)) && isWithinRetryWindow) {
              log(`Some entries missing EPS actuals, re-fetching from Nasdaq + Finnhub...`);
              const freshData = await fetchEarnings();
              const freshMap = Object.fromEntries(freshData.map(e => [e.symbol, e]));

              currentData = currentData.map(entry => {
                const fresh = freshMap[entry.symbol];
                if (!fresh) return entry;
                return {
                  ...entry,
                  epsActual: fresh.epsActual,
                  epsEstimated: fresh.epsEstimated,
                  surprise: fresh.surprise,
                  revenueActual: fresh.revenueActual,
                };
              });

              await databases.updateDocument(DATABASE_ID, EARNINGS_COLLECTION, currentDoc.$id, {
                earnings: JSON.stringify(currentData)
              });
            }

            const originalSymbols = new Set(currentData.map(e => e.symbol));
            const completeOriginals = currentData.filter(hasActualEPS);
            const missingCount = currentData.length - completeOriginals.length;

            if (completeOriginals.length === 0) {
              if (isWithinRetryWindow) {
                log(`Entries still missing EPS actuals for ${todayET}, will retry within 1h window.`);
              } else {
                log(`Retry window closed and no entries with EPS actuals for ${todayET}, skipping post.`);
              }
            } else if (missingCount > 0 && isWithinRetryWindow) {
              log(`Waiting for retry window to finish before filling gaps (${completeOriginals.length}/${currentData.length} complete).`);
            } else {
              // Retry window closed or all data complete — fill any gaps with next-ranked substitutes then post
              let postableData = completeOriginals;
              if (missingCount > 0) {
                const freshData = await fetchEarnings();
                const substitutes = freshData
                  .filter(e => !originalSymbols.has(e.symbol) && hasActualEPS(e))
                  .slice(0, missingCount);
                postableData = [...completeOriginals, ...substitutes];
                if (substitutes.length > 0) {
                  log(`Replaced ${missingCount} incomplete entries with ${substitutes.length} substitutes: ${substitutes.map(e => e.symbol).join(', ')}`);
                }
              }
              postableData.sort((a, b) => b.marketCap - a.marketCap);
              const beat = (actual, est) => actual != null && est != null ? (actual >= est ? '✅' : '❌') : '';
              const lines = postableData.map(entry => {
                const label = `[${entry.symbol}](https://finance.yahoo.com/quote/${entry.symbol})${entry.name ? ` (${entry.name})` : ''}`;
                const surpriseStr = entry.surprise != null
                  ? (entry.surprise >= 0 ? '+' : '') + entry.surprise.toFixed(2) + '%'
                  : '';
                const eps = `EPS **${formatEps(entry.epsActual)}** ${beat(entry.epsActual, entry.epsEstimated)} (est. ${formatEps(entry.epsEstimated)})${surpriseStr ? ' ' + surpriseStr : ''}`;
                const revActual = formatRevenue(entry.revenueActual);
                const rev = revActual != null ? `Rev. **${revActual}**` : null;
                return `${label}\n${eps}${rev ? '\n' + rev : ''}`;
              });

              const formattedDate = nowUTC.toLocaleString('pl-PL', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                timeZone: 'Europe/Warsaw'
              });

              const postContent = `**Wyniki kwartalne - ${formattedDate}**
Wszystkie wyniki z ostatnich 90 dni dostępne [na stronie](https://wykop-index.appwrite.network/#earnings).

_EPS na podstawie danych GAAP._

${lines.join('\n\n')}

#gielda #wykopindex #krachsmieciuchindex`;

              log(`Posting earnings results for ${postableData.length} companies...`);

              // Create survey
              let surveyId = null;
              try {
                const surveyResponse = await fetch('https://wykop.pl/api/v3/entries/survey', {
                  method: 'POST',
                  headers: {
                    'accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${wykopToken}`
                  },
                  body: JSON.stringify({
                    data: {
                      question: 'Czy igrzyska śmierci były dziś dla ciebie łaskawe?',
                      answers: ['Tak, jest w pyte', 'Nie, isover', 'Moje śmieciuchy miały dzisiaj wolne']
                    }
                  })
                });
                if (surveyResponse.ok) {
                  const surveyResult = await surveyResponse.json();
                  surveyId = surveyResult.data.survey_id;
                  log(`Created survey, ID: ${surveyId}`);
                } else {
                  const errorText = await surveyResponse.text();
                  error(`Failed to create survey: ${surveyResponse.status} ${errorText}`);
                }
              } catch (surveyError) {
                error(`Error creating survey: ${surveyError.message}`);
              }

              // Post earnings entry
              const earningsPostBody = { content: postContent, adult: false };
              if (surveyId) earningsPostBody.survey = surveyId;

              const earningsPostResponse = await fetch('https://wykop.pl/api/v3/entries', {
                method: 'POST',
                headers: {
                  'accept': 'application/json',
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${wykopToken}`
                },
                body: JSON.stringify({ data: earningsPostBody })
              });

              if (!earningsPostResponse.ok) {
                const errorText = await earningsPostResponse.text();
                throw new Error(`Failed to post earnings to Wykop: ${earningsPostResponse.status} ${errorText}`);
              }

              const earningsPostResult = await earningsPostResponse.json();
              const earningsEntryId = earningsPostResult.data.id;
              log(`Successfully posted earnings results, entry ID: ${earningsEntryId}`);

              await databases.updateDocument(DATABASE_ID, EARNINGS_COLLECTION, currentDoc.$id, {
                earnings: JSON.stringify(postableData),
                posted: true
              });
              log(`Marked earnings record as posted.`);
            }
          }
        }
      }
    } catch (earningsError) {
      error(`Earnings calendar error: ${earningsError.message}`);
    }

    return res.empty();
  } catch(err) {
    error("Error: " + err.message);
    return res.json({
      error: err.message
    }, 500);
  }
};
