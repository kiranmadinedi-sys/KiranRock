
"use client";
import React, { useEffect, useState } from 'react';

const LocalDataPage = () => {
  const [tickers, setTickers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/localdata/tickers')
      .then(res => res.json())
      .then(data => {
        setTickers(data.tickers || []);
        setLoading(false);
      })
      .catch(err => {
        setError('Failed to load tickers');
        setLoading(false);
      });
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Local Data (Loaded Tickers)</h1>
      {loading && <div>Loading...</div>}
      {error && <div className="text-red-500">{error}</div>}
      {!loading && !error && (
        <div>
          <p className="mb-2">Total loaded tickers: <b>{tickers.length}</b></p>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {tickers.map(t => (
              <span key={t} className="bg-gray-100 rounded px-2 py-1 text-sm">{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default LocalDataPage;
