import { useState, useEffect } from "react";
import { databases } from "./lib/appwrite";
import { Query } from "appwrite";

const DATABASE_ID = '69617178003ac8ef4fba';
const EARNINGS_COLLECTION = 'earnings';

const formatEps = (val) =>
  val != null ? `$${Number(val).toFixed(2)}` : 'N/A';

const formatRevenue = (val) => {
  if (val == null) return null;
  const n = Number(val);
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toFixed(2)}`;
};

const formatDate = (dateStr) => {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
};

export function EarningsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  useEffect(() => {
    async function fetchEarnings() {
      setLoading(true);
      try {
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        ninetyDaysAgo.setUTCHours(0, 0, 0, 0);

        const response = await databases.listDocuments(
          DATABASE_ID,
          EARNINGS_COLLECTION,
          [
            Query.greaterThanEqual('$createdAt', ninetyDaysAgo.toISOString()),
            Query.orderDesc('$createdAt'),
            Query.limit(100)
          ]
        );

        const allRows = response.documents.flatMap(doc => {
          try {
            const entries = JSON.parse(doc.earnings);
            return Array.isArray(entries) ? entries : [];
          } catch {
            return [];
          }
        });

        allRows.sort((a, b) => {
          const dc = new Date(b.date) - new Date(a.date);
          return dc !== 0 ? dc : (a.symbol || '').localeCompare(b.symbol || '');
        });

        setRows(allRows);
      } catch (err) {
        console.error('Error fetching earnings:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchEarnings();
  }, []);

  const query = search.trim().toLowerCase();
  const filtered = query
    ? rows.filter(r =>
        r.symbol?.toLowerCase().includes(query) ||
        r.name?.toLowerCase().includes(query)
      )
    : rows;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const Spinner = () => (
    <div className="flex justify-center items-center p-8">
      <div role="status">
        <svg aria-hidden="true" className="h-8 w-8 animate-spin fill-[#FD366E] text-gray-200" viewBox="0 0 100 101" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z" fill="currentColor"/>
          <path d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z" fill="currentFill"/>
        </svg>
        <span className="sr-only">Ładowanie wyników...</span>
      </div>
    </div>
  );

  return (
    <section className="mt-2 w-full max-w-4xl">
      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Szukaj po tickerze lub nazwie spółki..."
          className="w-full px-4 py-2 border border-[#EDEDF0] rounded-md text-sm text-[#2D2D31] placeholder-[#97979B] focus:outline-none focus:border-[#FD366E]"
        />
      </div>

      {loading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <div className="text-center p-8 border border-[#EDEDF0] rounded-md bg-white">
          <p className="text-[#97979B]">{search ? 'Brak wyników dla podanej frazy' : 'Brak danych o wynikach kwartalnych'}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[#EDEDF0]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-[#EDEDF0]">
                <th className="text-left px-3 py-2 font-semibold text-[#97979B] whitespace-nowrap">Data</th>
                <th className="text-left px-3 py-2 font-semibold text-[#97979B] whitespace-nowrap">Ticker</th>
                <th className="text-left px-3 py-2 font-semibold text-[#97979B]">Spółka</th>
                <th className="text-right px-3 py-2 font-semibold text-[#97979B] whitespace-nowrap">EPS</th>
                <th className="text-right px-3 py-2 font-semibold text-[#97979B] whitespace-nowrap">EPS est.</th>
                <th className="text-right px-3 py-2 font-semibold text-[#97979B] whitespace-nowrap">Niespodzianka</th>
                <th className="text-right px-3 py-2 font-semibold text-[#97979B] whitespace-nowrap">Przychody</th>
                <th className="text-right px-3 py-2 font-semibold text-[#97979B] whitespace-nowrap">Przych. est.</th>
                <th className="text-right px-3 py-2 font-semibold text-[#97979B] whitespace-nowrap">Niespodzianka</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, i) => {
                const epsBeat = row.epsActual != null && row.epsEstimated != null
                  ? row.epsActual >= row.epsEstimated : null;
                const surprisePositive = row.surprise != null ? row.surprise >= 0 : null;
                const surpriseStr = row.surprise != null
                  ? (row.surprise >= 0 ? '+' : '') + Number(row.surprise).toFixed(2) + '%'
                  : null;
                const revActual = formatRevenue(row.revenueActual);
                const revEstimate = formatRevenue(row.revenueEstimate);
                const revBeat = row.revenueActual != null && row.revenueEstimate != null
                  ? row.revenueActual >= row.revenueEstimate : null;
                const revSurprise = (row.revenueActual != null && row.revenueEstimate != null && row.revenueEstimate !== 0)
                  ? (row.revenueActual - row.revenueEstimate) / Math.abs(row.revenueEstimate) * 100
                  : null;
                const revSurpriseStr = revSurprise != null
                  ? (revSurprise >= 0 ? '+' : '') + revSurprise.toFixed(2) + '%'
                  : null;

                return (
                  <tr
                    key={`${row.date}-${row.symbol}-${i}`}
                    className="border-b border-[#EDEDF0] last:border-0 hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-3 py-2 text-[#97979B] whitespace-nowrap">{formatDate(row.date)}</td>
                    <td className="px-3 py-2 font-bold text-[#2D2D31] whitespace-nowrap">{row.symbol}</td>
                    <td className="px-3 py-2 text-[#2D2D31] max-w-[180px] truncate">{row.name || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold text-[#2D2D31] whitespace-nowrap">
                      {row.epsActual != null ? (
                        <span>
                          {formatEps(row.epsActual)}
                          {epsBeat !== null && (
                            <span className="ml-1">{epsBeat ? '✅' : '❌'}</span>
                          )}
                        </span>
                      ) : <span className="text-[#97979B] font-normal">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-[#97979B] whitespace-nowrap">
                      {formatEps(row.epsEstimated)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {surpriseStr ? (
                        <span className={`font-semibold ${surprisePositive ? 'text-green-600' : 'text-red-600'}`}>
                          {surpriseStr}
                        </span>
                      ) : <span className="text-[#97979B]">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-[#2D2D31] whitespace-nowrap">
                      {revActual != null ? (
                        <span>
                          {revActual}
                          {revBeat !== null && (
                            <span className="ml-1">{revBeat ? '✅' : '❌'}</span>
                          )}
                        </span>
                      ) : <span className="text-[#97979B] font-normal">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-[#97979B] whitespace-nowrap">
                      {revEstimate ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {revSurpriseStr ? (
                        <span className={`font-semibold ${revSurprise >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {revSurpriseStr}
                        </span>
                      ) : <span className="text-[#97979B]">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-[#97979B]">
            {filtered.length} {filtered.length === 1 ? 'spółka' : 'spółek'} · ostatnie 90 dni
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-2 py-1 text-xs rounded border border-[#EDEDF0] text-[#2D2D31] disabled:opacity-40 hover:border-[#FD366E] hover:text-[#FD366E] disabled:hover:border-[#EDEDF0] disabled:hover:text-[#2D2D31] transition-colors"
              >
                ‹
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(p => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1)
                .reduce((acc, p, idx, arr) => {
                  if (idx > 0 && p - arr[idx - 1] > 1) acc.push('...');
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, idx) =>
                  p === '...' ? (
                    <span key={`ellipsis-${idx}`} className="px-1 text-xs text-[#97979B]">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`px-2 py-1 text-xs rounded border transition-colors ${
                        p === currentPage
                          ? 'border-[#FD366E] text-[#FD366E] font-semibold'
                          : 'border-[#EDEDF0] text-[#2D2D31] hover:border-[#FD366E] hover:text-[#FD366E]'
                      }`}
                    >
                      {p}
                    </button>
                  )
                )
              }
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-2 py-1 text-xs rounded border border-[#EDEDF0] text-[#2D2D31] disabled:opacity-40 hover:border-[#FD366E] hover:text-[#FD366E] disabled:hover:border-[#EDEDF0] disabled:hover:text-[#2D2D31] transition-colors"
              >
                ›
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
