import * as sdk from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    // Initialize Appwrite client
    const client = new sdk.Client()
      .setEndpoint('https://fra.cloud.appwrite.io/v1')
      .setProject('wykopindex')
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new sdk.Databases(client);

    // Authenticate with Wykop API
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
    log("Successfully authenticated with Wykop");

    // Fetch the most recent sentiment entry
    const sentimentResponse = await databases.listDocuments(
      '69617178003ac8ef4fba', // Database ID
      'sentiment', // Table ID
      [
        sdk.Query.orderDesc('$createdAt'),
        sdk.Query.limit(1)
      ]
    );

    if (sentimentResponse.documents.length === 0) {
      throw new Error('No sentiment data found in database');
    }

    const latestSentiment = sentimentResponse.documents[0];
    const mostActiveUsers = JSON.parse(latestSentiment.mostActiveUsers);
    const mostDiscussed = JSON.parse(latestSentiment.mostDiscussed);

    // Format the post content
    const postContent = `[Krach & Śmieciuch Index](https://wykop-index.appwrite.network/) - stan na ${new Date(latestSentiment.$createdAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}

Sentyment: **${latestSentiment.sentiment}/100 ${latestSentiment.sentiment <= 20 ? '💩' : latestSentiment.sentiment <= 40 ? '🚽' : latestSentiment.sentiment <= 60 ? '🆗' : latestSentiment.sentiment <= 80 ? '🚀' : '🔥'}**

${latestSentiment.summary}

👤 Topowi analitycy:
${Array.isArray(mostActiveUsers) && mostActiveUsers.length > 0 ? mostActiveUsers.slice(0, 3).map(user => `• @${user}`).join('\n') : ''}

📉 Najczęściej omawiane (nie kupować, zaraz spadnie):
${Array.isArray(mostDiscussed) && mostDiscussed.length > 0 ? mostDiscussed.slice(0, 3).map(topic => `• ${topic}`).join('\n') : ''}

${latestSentiment.tomekSentiment ? `\nTomekIndicator®: ${latestSentiment.tomekSentiment}/100\n${latestSentiment.tomekSummary}` : ''}

#gielda #wykopindex #krachsmieciuchindex`;

    // Try to upload image, but continue without it if it fails
    let photoKey = null;
    try {
      const fileId = latestSentiment.imageId || 'wykopindex';
      
      if (latestSentiment.imageId) {
        log(`Using custom image: ${fileId}`);
      } else {
        log(`No imageId found, trying default image: ${fileId}`);
      }

      const imageUrl = `${process.env.BUCKET_URL}/files/${fileId}/view?project=wykopindex`;
      log(`Uploading image to Wykop: ${imageUrl}`);

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
        log(`Image uploaded successfully with key: ${photoKey}`);
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
    log(`Successfully posted to Wykop: ${postResult.data.id}`);

    return res.empty();
  } catch(err) {
    error("Error: " + err.message);
    return res.json({
      error: err.message
    }, 500);
  }
};
