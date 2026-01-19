import { useState, useEffect } from "react";
import "./App.css";
import { databases, storage } from "./lib/appwrite";
import { Query } from "appwrite";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

function App() {
  const [sentimentData, setSentimentData] = useState([]);
  const [loadingSentiment, setLoadingSentiment] = useState(true);
  const [imageUrl, setImageUrl] = useState(null);
  const [yesterdaySentiment, setYesterdaySentiment] = useState(null);
  const [weekAgoSentiment, setWeekAgoSentiment] = useState(null);
  const [historicalData, setHistoricalData] = useState([]);

  // Fetch sentiment data and latest image from Appwrite
  useEffect(() => {
    async function fetchData() {
      setLoadingSentiment(true);
      try {
        // Fetch the latest sentiment entry
        const response = await databases.listDocuments(
          '69617178003ac8ef4fba', // Database ID
          'sentiment', // Table ID
          [
            Query.orderDesc('$createdAt'),
            Query.limit(1)
          ]
        );
        setSentimentData(response.documents);

        // Fetch historical data for last 30 days
        try {
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          const historicalResponse = await databases.listDocuments(
            '69617178003ac8ef4fba',
            'sentiment',
            [
              Query.greaterThan('$createdAt', thirtyDaysAgo.toISOString()),
              Query.orderAsc('$createdAt'),
              Query.limit(100)
            ]
          );
          
          const chartData = historicalResponse.documents.map(doc => ({
            date: new Date(doc.$createdAt).toLocaleDateString('pl-PL', { 
              day: '2-digit', 
              month: '2-digit',
              timeZone: 'Europe/Warsaw'
            }),
            sentiment: doc.sentiment,
            tomekSentiment: doc.tomekSentiment,
            timestamp: doc.$createdAt,
            createdAt: new Date(doc.$createdAt)
          }));
          
          // Group by date and calculate averages
          const groupedByDate = chartData.reduce((acc, item) => {
            if (!acc[item.date]) {
              acc[item.date] = {
                date: item.date,
                sentiments: [],
                tomekSentiments: [],
                timestamp: item.timestamp
              };
            }
            acc[item.date].sentiments.push(item.sentiment);
            acc[item.date].tomekSentiments.push(item.tomekSentiment);
            return acc;
          }, {});
          
          const averagedData = Object.values(groupedByDate).map(group => ({
            date: group.date,
            sentiment: Math.round(group.sentiments.reduce((sum, val) => sum + val, 0) / group.sentiments.length),
            tomekSentiment: Math.round(group.tomekSentiments.reduce((sum, val) => sum + val, 0) / group.tomekSentiments.length),
            timestamp: group.timestamp
          }));
          
          setHistoricalData(averagedData);

          // Extract yesterday's sentiment from averaged data
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayFormatted = yesterday.toLocaleDateString('pl-PL', {
            day: '2-digit',
            month: '2-digit',
            timeZone: 'Europe/Warsaw'
          });
          const yesterdayData = averagedData.find(item => item.date === yesterdayFormatted);
          if (yesterdayData) {
            setYesterdaySentiment(yesterdayData.sentiment);
          }

          // Extract week ago sentiment from averaged data
          const weekAgo = new Date();
          weekAgo.setDate(weekAgo.getDate() - 7);
          const weekAgoFormatted = weekAgo.toLocaleDateString('pl-PL', {
            day: '2-digit',
            month: '2-digit',
            timeZone: 'Europe/Warsaw'
          });
          const weekAgoData = averagedData.find(item => item.date === weekAgoFormatted);
          if (weekAgoData) {
            setWeekAgoSentiment(weekAgoData.sentiment);
          }
        } catch (err) {
          console.error('Error fetching historical data:', err);
        }

        // Fetch the composite image from the latest sentiment data
        if (response.documents.length > 0) {
          const fileId = response.documents[0].imageId || 'wykopindex_v2'; // Default to 'wykopindex_v2' if imageId is null
          const imageViewUrl = storage.getFileView(
            '6961715000182498a35a', // Bucket ID
            fileId
          );
          setImageUrl(imageViewUrl);
        }

        setLoadingSentiment(false);
      } catch (err) {
        console.error('Error fetching data:', err);
        setLoadingSentiment(false);
      }
    }
    
    fetchData();
  }, []);

  return (
    <main className="flex flex-col items-center p-2 md:p-5 min-h-screen bg-white">
      {/* Sentiment Data Display */}
      <section className="mt-2 w-full max-w-4xl">
        {loadingSentiment ? (
          <div className="flex justify-center items-center p-8">
            <div role="status">
              <svg
                aria-hidden="true"
                className="h-8 w-8 animate-spin fill-[#FD366E] text-gray-200"
                viewBox="0 0 100 101"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z"
                  fill="currentColor"
                />
                <path
                  d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z"
                  fill="currentFill"
                />
              </svg>
              <span className="sr-only">Ładowanie danych o sentymencie...</span>
            </div>
          </div>
        ) : sentimentData.length === 0 ? (
          <div className="text-center p-8 border border-[#EDEDF0] rounded-md bg-white">
            <p className="text-[#97979B]">Brak dostępnych danych o sentymencie</p>
          </div>
        ) : (
          <div className="space-y-4">
            {sentimentData.map((item) => (
              <div key={item.$id} className="rounded-md bg-white overflow-hidden">
                {imageUrl && (
                  <div className="px-6 pt-6">
                    <img 
                      src={imageUrl} 
                      alt="Wykop sentiment visualization" 
                      className="w-full"
                    />
                  </div>
                )}
                <div className="p-6">
                <div className="flex flex-col items-center mb-4">
                  <div 
                    className="text-5xl font-bold mb-3"
                    style={{
                      color: item.sentiment <= 20 ? '#b91c1c' :
                             item.sentiment <= 40 ? '#ef4444' :
                             item.sentiment <= 60 ? '#FFBF00' :
                             item.sentiment <= 80 ? '#4CBB17' :
                             '#008000'
                    }}
                  >
                    {item.sentiment}
                  </div>
                  <div className="h-3 w-full max-w-md bg-gray-200 rounded-full overflow-hidden mb-2">
                    <div 
                      className="h-full"
                      style={{ 
                        width: `${item.sentiment}%`,
                        backgroundColor: item.sentiment <= 20 ? '#b91c1c' :
                                       item.sentiment <= 40 ? '#ef4444' :
                                       item.sentiment <= 60 ? '#FFBF00' :
                                       item.sentiment <= 80 ? '#4CBB17' :
                                       '#008000'
                      }}
                    ></div>
                  </div>
                  <div className="text-sm text-[#97979B]">
                    {new Date(item.$createdAt).toLocaleString('pl-PL', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: 'Europe/Warsaw'
                    })}
                  </div>
                </div>
                
                {/* Historical sentiment comparison */}
                <div className="mt-4 flex flex-col gap-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-[#97979B]">Wczoraj:</span>
                    {yesterdaySentiment !== null ? (
                      <>
                        <span 
                          className="font-bold"
                          style={{
                            color: yesterdaySentiment <= 20 ? '#b91c1c' :
                                   yesterdaySentiment <= 40 ? '#ef4444' :
                                   yesterdaySentiment <= 60 ? '#FFBF00' :
                                   yesterdaySentiment <= 80 ? '#4CBB17' :
                                   '#008000'
                          }}
                        >
                          {yesterdaySentiment}
                        </span>
                        {item.sentiment > yesterdaySentiment && (
                          <span className="text-green-600">↑ {item.sentiment - yesterdaySentiment}</span>
                        )}
                        {item.sentiment < yesterdaySentiment && (
                          <span className="text-red-600">↓ {yesterdaySentiment - item.sentiment}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-[#97979B]">-</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[#97979B]">Tydzień temu:</span>
                    {weekAgoSentiment !== null ? (
                      <>
                        <span 
                          className="font-bold"
                          style={{
                            color: weekAgoSentiment <= 20 ? '#b91c1c' :
                                   weekAgoSentiment <= 40 ? '#ef4444' :
                                   weekAgoSentiment <= 60 ? '#FFBF00' :
                                   weekAgoSentiment <= 80 ? '#4CBB17' :
                                   '#008000'
                          }}
                        >
                          {weekAgoSentiment}
                        </span>
                        {item.sentiment > weekAgoSentiment && (
                          <span className="text-green-600">↑ {item.sentiment - weekAgoSentiment}</span>
                        )}
                        {item.sentiment < weekAgoSentiment && (
                          <span className="text-red-600">↓ {weekAgoSentiment - item.sentiment}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-[#97979B]">-</span>
                    )}
                  </div>
                </div>
                
                <div className="space-y-4 mt-6">
                  <div id="analiza-sentymentu">
                    <h3 className="text-lg font-bold text-[#2D2D31] mb-1">
                      <a href="#analiza-sentymentu" className="hover:underline">Analiza sentymentu</a>
                    </h3>
                    <p className="text-[#2D2D31] font-medium">{item.summary}</p>
                  </div>

                  {item.mostDiscussed && (
                    <div className="mt-6" id="najczesciej-omawiane">
                      <h3 className="text-lg font-bold text-[#FF0000] mb-1">
                        <a href="#najczesciej-omawiane" className="hover:underline">Najczęściej omawiane</a>
                      </h3>
                      <div className="space-y-1">
                        {(item.mostDiscussed.startsWith('[') ? JSON.parse(item.mostDiscussed) : item.mostDiscussed.split(',')).map((topic, index) => (
                          <div key={index} className="flex items-center gap-2 text-[#97979B]">
                            <span className="text-[#2D2D31]">🔥</span>
                            <span className="text-[#2D2D31] font-medium">{typeof topic === 'string' ? topic.trim() : topic}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {item.mostActiveUsers && (
                    <div className="mt-6" id="topowi-analitycy">
                      <h3 className="text-lg font-bold text-[#0047AB] mb-1">
                        <a href="#topowi-analitycy" className="hover:underline">Topowi analitycy</a>
                      </h3>
                      <div className="space-y-1">
                        {(item.mostActiveUsers.startsWith('[') ? JSON.parse(item.mostActiveUsers) : item.mostActiveUsers.split(',')).map((user, index) => (
                          <div key={index} className="flex items-center gap-2 text-[#97979B]">
                            <span className="text-[#2D2D31]">👤</span>
                            <span className="text-[#2D2D31] font-medium">{typeof user === 'string' ? user.trim() : user}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {item.tomekSentiment && (
                    <div className="mt-6" id="tomekindicator">
                        <h3 className="text-lg font-bold text-[#808080] mb-1">
                          <a href="#tomekindicator" className="hover:underline">TomekIndicator®</a>
                        </h3>
                        <div className="space-y-2">
                          <div>
                            <div className="flex items-center gap-3 mb-2">
                              <div 
                                className="text-2xl font-bold"
                                style={{
                                  color: '#808080'
                                }}
                              >
                                {item.tomekSentiment}
                              </div>
                              <div className="h-2 flex-1 bg-gray-200 rounded-full overflow-hidden">
                                <div 
                                  className="h-full"
                                  style={{ 
                                    width: `${item.tomekSentiment}%`,
                                    backgroundColor: '#808080'
                                  }}
                                ></div>
                              </div>
                            </div>
                            <p className="text-[#2D2D31] font-medium text-sm">{item.tomekSummary}</p>
                          </div>
                        </div>
                    </div>
                  )}
                </div>
                {/* Historical Chart */}
                {historicalData.length > 0 && (
                  <div className="mt-6" id="ostatnie-30-dni">
                    <h3 className="text-lg font-bold text-[#2D2D31] mb-1">
                      <a href="#ostatnie-30-dni" className="hover:underline">Ostatnie 30 dni</a>
                    </h3>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={historicalData} margin={{ top: 5, right: 5, left: -30, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#EDEDF0" />
                        <XAxis 
                          dataKey="date" 
                          stroke="#2D2D31"
                          style={{ fontSize: '12px' }}
                          interval="preserveStartEnd"
                        />
                        <YAxis 
                          domain={[0, 100]}
                          stroke="#2D2D31"
                          style={{ fontSize: '12px' }}
                        />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'white', 
                            border: '1px solid #EDEDF0',
                            borderRadius: '4px'
                          }}
                        />
                        <Legend />
                        <Line 
                          type="monotone" 
                          dataKey="sentiment" 
                          stroke="#0047AB" 
                          strokeWidth={2}
                          name="Krach & Śmieciuch Index"
                          dot={{ fill: '#0047AB', r: 3 }}
                        />
                        <Line 
                          type="monotone" 
                          dataKey="tomekSentiment" 
                          stroke="#808080" 
                          strokeWidth={2}
                          name="TomekIndicator®"
                          dot={{ fill: '#808080', r: 3 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
