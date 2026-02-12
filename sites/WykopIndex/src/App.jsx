import { useState, useEffect } from "react";
import "./App.css";
import { databases, storage } from "./lib/appwrite";
import { Query } from "appwrite";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

// Constants
const DATABASE_ID = '69617178003ac8ef4fba';
const SENTIMENT_COLLECTION_ID = 'sentiment';
const REPLIES_COLLECTION_ID = 'replies';
const BUCKET_ID = '6961715000182498a35a';

// Helper functions
const getSentimentColor = (sentiment) => {
  if (sentiment <= 20) return '#b91c1c';
  if (sentiment <= 40) return '#ef4444';
  if (sentiment <= 60) return '#FFBF00';
  if (sentiment <= 80) return '#4CBB17';
  return '#008000';
};

const formatUTCDate = (date) => {
  return new Date(date).toLocaleDateString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC'
  });
};

function App() {
  const [sentimentData, setSentimentData] = useState([]);
  const [loadingSentiment, setLoadingSentiment] = useState(true);
  const [error, setError] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [chartData, setChartData] = useState({ sentiment: [], entries: [] });
  const [comparisons, setComparisons] = useState({
    yesterdaySentiment: null,
    weekAgoSentiment: null,
    yesterdayEntries: null,
    weekAgoFollowers: null
  });
  const [replies, setReplies] = useState([]);
  const [loadingReplies, setLoadingReplies] = useState(true);

  // Fetch sentiment data and latest image from Appwrite
  useEffect(() => {
    async function fetchData() {
      setLoadingSentiment(true);
      try {
        // Fetch the latest sentiment entry
        const response = await databases.listDocuments(
          DATABASE_ID,
          SENTIMENT_COLLECTION_ID,
          [
            Query.orderDesc('$createdAt'),
            Query.limit(1)
          ]
        );
        
        // Parse JSON strings into objects
        const parsedDocuments = response.documents.map(doc => ({
          ...doc,
          mostActiveUsers: doc.mostActiveUsers?.startsWith('[') ? JSON.parse(doc.mostActiveUsers) : [],
          mostDiscussed: doc.mostDiscussed?.startsWith('[') ? JSON.parse(doc.mostDiscussed) : [],
          mentionsReplies: doc.mentionsReplies?.startsWith('[') ? JSON.parse(doc.mentionsReplies) : [],
          mostEntriesLast24h: doc.mostEntriesLast24h?.startsWith('{') ? JSON.parse(doc.mostEntriesLast24h) : null,
          mostCommentsLast24h: doc.mostCommentsLast24h?.startsWith('{') ? JSON.parse(doc.mostCommentsLast24h) : null,
          mostCombinedLast24h: doc.mostCombinedLast24h?.startsWith('{') ? JSON.parse(doc.mostCombinedLast24h) : null
        }));
        
        setSentimentData(parsedDocuments);

        // Fetch historical data for last 30 days
        try {
          const now = new Date();
          const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          const historicalResponse = await databases.listDocuments(
            DATABASE_ID,
            SENTIMENT_COLLECTION_ID,
            [
              Query.greaterThan('$createdAt', thirtyDaysAgo.toISOString()),
              Query.orderAsc('$createdAt'),
              Query.limit(150)
            ]
          );
          
          const chartData = historicalResponse.documents.map(doc => ({
            date: formatUTCDate(doc.$createdAt),
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

          // Extract yesterday's and week ago sentiment from averaged data
          const nowUTC = new Date();
          const yesterdayUTC = new Date(nowUTC.getTime() - 24 * 60 * 60 * 1000);
          const yesterdayFormatted = formatUTCDate(yesterdayUTC);
          const yesterdayData = averagedData.find(item => item.date === yesterdayFormatted);

          const weekAgoUTC = new Date(nowUTC.getTime() - 7 * 24 * 60 * 60 * 1000);
          const weekAgoFormatted = formatUTCDate(weekAgoUTC);
          const weekAgoData = averagedData.find(item => item.date === weekAgoFormatted);

          // Extract yesterday's entries and week ago followers using UTC boundaries
          const startOfTodayUTC = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate()));
          const startOfYesterdayUTC = new Date(startOfTodayUTC.getTime() - 24 * 60 * 60 * 1000);
          const startOfWeekAgoUTC = new Date(startOfTodayUTC.getTime() - 7 * 24 * 60 * 60 * 1000);
          const endOfWeekAgoUTC = new Date(startOfWeekAgoUTC.getTime() + 24 * 60 * 60 * 1000);
          
          const yesterdayEntries = historicalResponse.documents.filter(doc => {
            if (response.documents.length > 0 && doc.$id === response.documents[0].$id) return false;
            const docDate = new Date(doc.$createdAt);
            return docDate >= startOfYesterdayUTC && docDate < startOfTodayUTC;
          });
          
          const weekAgoEntries = historicalResponse.documents.filter(doc => {
            if (response.documents.length > 0 && doc.$id === response.documents[0].$id) return false;
            const docDate = new Date(doc.$createdAt);
            return docDate >= startOfWeekAgoUTC && docDate < endOfWeekAgoUTC;
          });

          // Process entries data for chart
          const entriesChartData = historicalResponse.documents
            .filter(doc => doc.entriesLast24h)
            .map(doc => ({
              date: formatUTCDate(doc.$createdAt),
              entries: doc.entriesLast24h,
              timestamp: doc.$createdAt
            }));
          
          // Group by date and take the latest entry for each date
          const entriesGroupedByDate = entriesChartData.reduce((acc, item) => {
            if (!acc[item.date] || new Date(item.timestamp) > new Date(acc[item.date].timestamp)) {
              acc[item.date] = item;
            }
            return acc;
          }, {});
          
          const entriesData = Object.values(entriesGroupedByDate).sort((a, b) => 
            new Date(a.timestamp) - new Date(b.timestamp)
          );
          
          // Set all state in one operation
          setChartData({ sentiment: averagedData, entries: entriesData });
          setComparisons({
            yesterdaySentiment: yesterdayData?.sentiment ?? null,
            weekAgoSentiment: weekAgoData?.sentiment ?? null,
            yesterdayEntries: yesterdayEntries.length > 0 ? yesterdayEntries[yesterdayEntries.length - 1].entriesLast24h : null,
            weekAgoFollowers: weekAgoEntries.length > 0 ? weekAgoEntries[weekAgoEntries.length - 1].followers : null
          });
        } catch (err) {
          console.error('Error fetching historical data:', err);
          setError('Nie udało się pobrać danych historycznych');
        }

        // Fetch the composite image from the latest sentiment data
        if (response.documents.length > 0) {
          const fileId = response.documents[0].imageId || 'wykopindex_v2';
          const imageViewUrl = storage.getFileView(BUCKET_ID, fileId);
          setImageUrl(imageViewUrl);
        }

        setLoadingSentiment(false);
      } catch (err) {
        console.error('Error fetching data:', err);
        setError('Nie udało się pobrać danych o sentymencie');
        setLoadingSentiment(false);
      }
    }
    
    async function fetchReplies() {
      setLoadingReplies(true);
      try {
        const response = await databases.listDocuments(
          DATABASE_ID,
          REPLIES_COLLECTION_ID,
          [
            Query.orderDesc('$createdAt'),
            Query.limit(5)
          ]
        );
        setReplies(response.documents);
      } catch (err) {
        console.error('Error fetching replies:', err);
      } finally {
        setLoadingReplies(false);
      }
    }
    
    fetchData();
    fetchReplies();
  }, []);

  // Scroll to hash anchor after data loads
  useEffect(() => {
    if (!loadingSentiment && window.location.hash) {
      const id = window.location.hash.substring(1);
      const element = document.getElementById(id);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [loadingSentiment]);

  return (
    <main className="flex flex-col items-center p-2 md:p-5 min-h-screen bg-white">
      {/* Error Display */}
      {error && (
        <div className="w-full max-w-4xl mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-red-800 text-sm">{error}</p>
        </div>
      )}

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
                    style={{ color: getSentimentColor(item.sentiment) }}
                  >
                    {item.sentiment}
                  </div>
                  <div className="h-3 w-full max-w-md bg-gray-200 rounded-full overflow-hidden mb-2">
                    <div 
                      className="h-full"
                      style={{ 
                        width: `${item.sentiment}%`,
                        backgroundColor: getSentimentColor(item.sentiment)
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
                    {comparisons.yesterdaySentiment !== null ? (
                      <>
                        <span 
                          className="font-bold"
                          style={{ color: getSentimentColor(comparisons.yesterdaySentiment) }}
                        >
                          {comparisons.yesterdaySentiment}
                        </span>
                      </>
                    ) : (
                      <span className="text-[#97979B]">-</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[#97979B]">Tydzień temu:</span>
                    {comparisons.weekAgoSentiment !== null ? (
                      <>
                        <span 
                          className="font-bold"
                          style={{ color: getSentimentColor(comparisons.weekAgoSentiment) }}
                        >
                          {comparisons.weekAgoSentiment}
                        </span>
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

                  {item.mostDiscussed && item.mostDiscussed.length > 0 && (
                    <div className="mt-6" id="najczesciej-omawiane">
                      <h3 className="text-lg font-bold text-[#FF0000] mb-1">
                        <a href="#najczesciej-omawiane" className="hover:underline">Najczęściej omawiane</a>
                      </h3>
                      <div className="space-y-1">
                        {item.mostDiscussed.map((topic, index) => (
                          <div key={index} className="flex items-start gap-2">
                            <span className="text-[#2D2D31]">🔥</span>
                            <div className="flex-1">
                              <span className="text-[#2D2D31] font-medium">{topic.asset}</span>
                              <span className="text-[#2D2D31] font-medium">: {topic.reasoning}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {item.mostActiveUsers && item.mostActiveUsers.length > 0 && (
                    <div className="mt-6" id="topowi-analitycy">
                      <h3 className="text-lg font-bold text-[#0047AB] mb-1">
                        <a href="#topowi-analitycy" className="hover:underline">Topowi analitycy</a>
                      </h3>
                      <div className="space-y-1">
                        {item.mostActiveUsers.map((user, index) => (
                          <div key={index} className="flex items-start gap-2">
                            <span className="text-[#2D2D31]">👤</span>
                            <div className="flex-1">
                              <span className="text-[#2D2D31] font-medium">{user.username}</span>
                              <span className="text-[#2D2D31] font-medium ml-1">({user.sentiment}): </span>
                              <a href={user.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-800 italic">&ldquo;{user.quote}&rdquo;</a>
                            </div>
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

                  {/* Statistics Section */}
                  {(item.followers || item.entriesLast24h || item.mostEntriesLast24h || item.mostCommentsLast24h || item.mostCombinedLast24h) && (
                    <div className="mt-6" id="statystyki">
                      <h3 className="text-lg font-bold text-[#CD7F32] mb-3">
                        <a href="#statystyki" className="hover:underline">Statystyki tagu</a>
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {item.followers && (
                          <div className="bg-gray-50 p-4 rounded-lg">
                            <div className="text-sm text-[#97979B] mb-1">Obserwujący</div>
                            <div className="text-2xl font-bold text-[#2D2D31]">{item.followers.toLocaleString('pl-PL')}</div>
                            {comparisons.weekAgoFollowers !== null && (
                              <div className="text-sm mt-2">
                                <span className="text-[#97979B]">Tydzień temu: </span>
                                <span className="font-semibold text-[#2D2D31]">{comparisons.weekAgoFollowers.toLocaleString('pl-PL')}</span>
                                {item.followers !== comparisons.weekAgoFollowers && (
                                  <span className={`ml-1 font-semibold ${item.followers > comparisons.weekAgoFollowers ? 'text-[#008000]' : 'text-[#b91c1c]'}`}>
                                    ({item.followers > comparisons.weekAgoFollowers ? '+' : '-'}{Math.abs(item.followers - comparisons.weekAgoFollowers).toLocaleString('pl-PL')})
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        {item.entriesLast24h && (
                          <div className="bg-gray-50 p-4 rounded-lg">
                            <div className="text-sm text-[#97979B] mb-1">Wpisy (ostatnie 24h)</div>
                            <div className="text-2xl font-bold text-[#2D2D31]">{item.entriesLast24h.toLocaleString('pl-PL')}</div>
                            {comparisons.yesterdayEntries !== null && (
                              <div className="text-sm mt-2">
                                <span className="text-[#97979B]">Wczoraj: </span>
                                <span className="font-semibold text-[#2D2D31]">{comparisons.yesterdayEntries.toLocaleString('pl-PL')}</span>
                                {item.entriesLast24h !== comparisons.yesterdayEntries && (
                                  <span className={`ml-1 font-semibold ${item.entriesLast24h > comparisons.yesterdayEntries ? 'text-[#008000]' : 'text-[#b91c1c]'}`}>
                                    ({((item.entriesLast24h - comparisons.yesterdayEntries) / comparisons.yesterdayEntries * 100) >= 0 ? '+' : ''}{Math.round((item.entriesLast24h - comparisons.yesterdayEntries) / comparisons.yesterdayEntries * 100)}%)
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        {(item.mostEntriesLast24h || item.mostCommentsLast24h || item.mostCombinedLast24h) && (
                          <div className="bg-gray-50 p-4 rounded-lg md:col-span-2">
                            <div className="text-sm text-[#97979B] mb-3">Najaktywniejsi użytkownicy (ostatnie 24h)</div>
                            <div className="flex justify-between items-start">
                              {item.mostCombinedLast24h && (
                                <div className="text-sm flex-1">
                                  <div className="text-[#97979B] mb-1">Najaktywniejszy ogółem:</div>
                                  <div className="font-bold text-[#2D2D31]">
                                    @{item.mostCombinedLast24h.username} ({item.mostCombinedLast24h.count})
                                  </div>
                                </div>
                              )}
                              {item.mostEntriesLast24h && (
                                <div className="text-sm flex-1 text-center">
                                  <div className="text-[#97979B] mb-1">Najwięcej wpisów:</div>
                                  <div className="font-semibold text-[#2D2D31]">
                                    @{item.mostEntriesLast24h.username} ({item.mostEntriesLast24h.count})
                                  </div>
                                </div>
                              )}
                              {item.mostCommentsLast24h && (
                                <div className="text-sm flex-1 text-right">
                                  <div className="text-[#97979B] mb-1">Najwięcej komentarzy:</div>
                                  <div className="font-semibold text-[#2D2D31]">
                                    @{item.mostCommentsLast24h.username} ({item.mostCommentsLast24h.count})
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {(chartData.sentiment.length > 0 || chartData.entries.length > 0) && (
                    <div className="mt-6" id="wykresy">
                      <h3 className="text-lg font-bold text-[#2D2D31] mb-3">
                        <a href="#wykresy" className="hover:underline">Wykresy</a>
                      </h3>
                      
                      {chartData.sentiment.length > 0 && (
                        <div className="mb-6">
                          <h4 className="text-md font-semibold text-[#2D2D31] mb-2">Sentyment (ostatnie 30 dni)</h4>
                          <ResponsiveContainer width="100%" height={300}>
                            <LineChart data={chartData.sentiment} margin={{ top: 5, right: 5, left: -30, bottom: 5 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#EDEDF0" />
                              <XAxis 
                                dataKey="date" 
                                stroke="#2D2D31"
                                style={{ fontSize: '12px' }}
                                angle={-45}
                                textAnchor="end"
                                height={60}
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

                      {chartData.entries.length > 0 && (
                        <div>
                          <h4 className="text-md font-semibold text-[#2D2D31] mb-2">Wpisy (ostatnie 30 dni)</h4>
                          <ResponsiveContainer width="100%" height={300}>
                            <LineChart data={chartData.entries} margin={{ top: 5, right: 5, left: -30, bottom: 5 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#EDEDF0" />
                              <XAxis 
                                dataKey="date" 
                                stroke="#2D2D31"
                                style={{ fontSize: '12px' }}
                                angle={-45}
                                textAnchor="end"
                                height={60}
                                interval="preserveStartEnd"
                              />
                              <YAxis 
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
                              <Line 
                                type="monotone" 
                                dataKey="entries" 
                                stroke="#CD7F32" 
                                strokeWidth={2}
                                dot={{ fill: '#CD7F32', r: 3 }}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>
                  )}

                  {!loadingReplies && replies.length > 0 && (
                    <div className="mt-6" id="odpowiedzi">
                      <h3 className="text-lg font-bold text-[#008000] mb-1">
                        <a href="#odpowiedzi" className="hover:underline">Odpowiedzi</a>
                      </h3>
                      <div className="space-y-3">
                        {replies.map((reply) => (
                          <div key={reply.$id} className="flex items-start gap-2 p-3 bg-gray-50 rounded">
                            <span className="text-[#2D2D31] mt-0.5">💬</span>
                            <div className="flex-1">
                              <div className="text-sm text-[#97979B] mb-1">
                                {reply.username}: <a href={reply.postUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-800">{reply.question}</a>
                              </div>
                              <div className="text-[#2D2D31] font-medium text-sm">
                                {reply.reply}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
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
