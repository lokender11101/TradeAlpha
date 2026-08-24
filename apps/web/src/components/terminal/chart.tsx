'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, IChartApi, ISeriesApi, Time, CandlestickSeries } from 'lightweight-charts';
import { useSocket } from '@/lib/socket-context';
import { apiFetch } from '@/lib/api';
import { RefreshCcw } from 'lucide-react';

export interface CandleResponse {
  symbol: string;
  timeframe: string;
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  isClosed: boolean;
}

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '1d'];

export function Chart({ symbol }: { symbol: string }) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const { socket, connected } = useSocket();
  
  const [timeframe, setTimeframe] = useState('1m');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasData, setHasData] = useState(false);
  
  // Single source of truth for chart data
  const dataMapRef = useRef<Map<number, CandleResponse>>(new Map());

  // Initialization of the chart
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#888',
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.2)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.2)' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
      autoSize: true,
    });

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    chartRef.current = chart;
    seriesRef.current = candlestickSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  const flushToChart = () => {
    if (!seriesRef.current) return;
    const sorted = Array.from(dataMapRef.current.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const chartData = sorted.map(c => ({
      time: (new Date(c.timestamp).getTime() / 1000) as Time,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
    }));
    seriesRef.current.setData(chartData);
    setHasData(dataMapRef.current.size > 0);
  };

  const mergeCandle = (candle: CandleResponse) => {
    const timeMs = new Date(candle.timestamp).getTime();
    const existing = dataMapRef.current.get(timeMs);
    if (existing) {
      // Deterministic merge: prefer closed, otherwise prefer higher volume
      if (existing.isClosed && !candle.isClosed) return false;
      if (parseFloat(existing.volume) > parseFloat(candle.volume) && !candle.isClosed) return false;
    }
    dataMapRef.current.set(timeMs, candle);
    return true;
  };

  const fetchHistorical = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/market/candles?symbol=${symbol}&timeframe=${timeframe}&limit=500`);
      if (!res.ok) throw new Error('Failed to fetch candles');
      const data: CandleResponse[] = await res.json();
      
      let changed = false;
      for (const candle of data) {
        if (mergeCandle(candle)) changed = true;
      }
      
      // Also cull old candles to avoid memory leaks if we want, but let's keep it simple
      if (changed || data.length === 0) {
        flushToChart();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error fetching chart data');
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe]);

  // Re-fetch on symbol/timeframe change
  useEffect(() => {
    dataMapRef.current.clear();
    flushToChart();
    fetchHistorical();
  }, [symbol, timeframe, fetchHistorical]);

  // Re-fetch on reconnect
  useEffect(() => {
    if (connected && !loading && symbol) {
      fetchHistorical();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Live WebSocket updates
  useEffect(() => {
    if (!socket || !connected) return;

    const handleMarketCandle = (event: any) => {
      // Strictly filter by symbol and timeframe
      const candle = event.payload;
      if (!candle) return;
      if (candle.symbol !== symbol) return;
      if (candle.timeframe !== timeframe) return;
      
      if (mergeCandle(candle)) {
        if (seriesRef.current) {
          seriesRef.current.update({
            time: (new Date(candle.timestamp).getTime() / 1000) as Time,
            open: parseFloat(candle.open),
            high: parseFloat(candle.high),
            low: parseFloat(candle.low),
            close: parseFloat(candle.close),
          });
        }
      }
    };

    socket.on('MARKET_CANDLE', handleMarketCandle);
    return () => {
      socket.off('MARKET_CANDLE', handleMarketCandle);
    };
  }, [socket, connected, symbol, timeframe]);

  return (
    <div className="flex-1 flex flex-col h-full w-full relative">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-lg flex items-center gap-2">
          Chart - {symbol}
          {loading && <RefreshCcw className="w-4 h-4 animate-spin text-muted-foreground" />}
        </h3>
        <div className="flex gap-2">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              data-testid={`timeframe-${tf}`}
              onClick={() => setTimeframe(tf)}
              className={`px-3 py-1 text-sm rounded ${timeframe === tf ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'}`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>
      
      <div className="relative flex-1 min-h-[300px] bg-card border rounded-lg overflow-hidden">
        {error && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-background/80">
            <div className="text-center">
              <p className="text-red-500 mb-2">{error}</p>
              <button onClick={fetchHistorical} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm">
                Retry
              </button>
            </div>
          </div>
        )}
        
        {(!loading && !error && !hasData) && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <p className="text-muted-foreground">No historical data available</p>
          </div>
        )}
        
        <div ref={chartContainerRef} className="absolute inset-0" data-testid="chart-container" />
      </div>
    </div>
  );
}
