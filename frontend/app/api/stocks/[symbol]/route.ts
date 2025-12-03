import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Mock chart data generator
function generateMockChartData(symbol: string, interval: string) {
  // Generate 30 days of mock data
  const now = Math.floor(Date.now() / 1000);
  const data = [];
  let price = 150;
  for (let i = 0; i < 30; i++) {
    const open = price + (Math.random() - 0.5) * 2;
    const close = open + (Math.random() - 0.5) * 2;
    const high = Math.max(open, close) + Math.random() * 1.5;
    const low = Math.min(open, close) - Math.random() * 1.5;
    const volume = Math.floor(1000000 + Math.random() * 500000);
    data.push({
      time: now - (30 - i) * 86400,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
    });
    price = close;
  }
  return data;
}

export async function GET(req: NextRequest, { params }: { params: { symbol: string } }) {
  const { symbol } = params;
  const { searchParams } = new URL(req.url);
  const interval = searchParams.get('interval') || '1d';
  // You can add logic for interval, includePrePost, etc. here
  const chartData = generateMockChartData(symbol, interval);
  return NextResponse.json(chartData);
}
