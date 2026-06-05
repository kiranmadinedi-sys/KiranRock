
import { NextResponse } from 'next/server';

export const dynamic = "force-dynamic";

// Fetch loaded tickers from backend Express API
export async function GET() {
  let tickers: string[] = [];
  try {
    let backendHost = process.env.NEXT_PUBLIC_API_BASE_URL || '';
    if (!backendHost) {
      backendHost = 'http://localhost:3001';
    }
    const backendUrl = `${backendHost.replace(/\/$/, '')}/api/localdata/tickers`;
    const res = await fetch(backendUrl, { next: { revalidate: 0 } });
    if (res.ok) {
      const data = await res.json();
      tickers = Array.isArray(data.tickers) ? data.tickers : [];
    } else {
      console.error('[localdata/tickers] Backend responded with status:', res.status, await res.text());
    }
  } catch (e) {
    console.error('[localdata/tickers] Fetch error:', e);
  }
  return NextResponse.json({ tickers });
}
