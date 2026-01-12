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

    const model = 'gemini-3-flash-preview';

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
    Odpowiedz w nastepujacym formacie JSON: ${responseFormat}. Nie dodawaj zadnych dodatkowych znakow lub formatowania.
    Wpisy: ${JSON.stringify(parsedData)}`;

    const response = await ai.models.generateContent({
      model: model,
      contents: prompt,
      config: {
        tools: [{urlContext: {}}],
      },
    });

    log("AI response: " + response.text);

    const sentimentResult = JSON.parse(response.text);
    
    // Ensure mostActiveUsers and mostDiscussed are strings
    if (Array.isArray(sentimentResult.mostActiveUsers)) {
      sentimentResult.mostActiveUsers = JSON.stringify(sentimentResult.mostActiveUsers);
    }
    if (Array.isArray(sentimentResult.mostDiscussed)) {
      sentimentResult.mostDiscussed = JSON.stringify(sentimentResult.mostDiscussed);
    }

    // --- TOMEK INDICATOR SECTION ---
    log("Starting Tomek Indicator analysis");

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
    Odpowiedz w nastepujacym formacie JSON: ${tomekResponseFormat}. Nie dodawaj zadnych dodatkowych znakow lub formatowania.
    Wpisy: ${JSON.stringify(filteredTomekData)}`;

    const tomekResponse = await ai.models.generateContent({
      model: model,
      contents: tomekPrompt,
      config: {
        tools: [{urlContext: {}}],
      },
    });

    log("Tomek AI response: " + tomekResponse.text);

    const tomekSentimentResult = JSON.parse(tomekResponse.text);

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
          tomekSummary: tomekSentimentResult.summary
        }
    );

    log("Database result: " + dbResult.$id);

    return res.empty();
  } catch(err) {
    error("Error: " + err.message);
    return res.json({
      error: err.message
    }, 500);
  }
};
