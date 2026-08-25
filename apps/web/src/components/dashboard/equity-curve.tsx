'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { createChart, IChartApi, ISeriesApi, Time, LineSeries } from 'lightweight-charts';

export function EquityCurve() {
  const { user } = useAuth();
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!user?.portfolioId) return;
    try {
      const res = await apiFetch(`/portfolios/${user.portfolioId}/history?limit=30`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setHistory(data);
      } else {
        setError('Failed to fetch history');
      }
    } catch (err) {
      setError('An error occurred');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    if (!chartContainerRef.current || history.length === 0) return;

    if (!chartRef.current) {
      const chart = createChart(chartContainerRef.current, {
        layout: {
          background: { color: 'transparent' },
          textColor: '#A3A3A3',
        },
        grid: {
          vertLines: { color: '#334155' },
          horzLines: { color: '#334155' },
        },
        timeScale: {
          timeVisible: false,
          borderColor: '#334155',
        },
        rightPriceScale: {
          borderColor: '#334155',
        },
        autoSize: true,
      });

      const series = chart.addSeries(LineSeries, {
        color: '#3b82f6',
        lineWidth: 2,
      });

      chartRef.current = chart;
      seriesRef.current = series;
    }

    const data = history.map(h => ({
      time: (new Date(h.date).getTime() / 1000) as Time,
      value: parseFloat(h.nav),
    }));

    // Ensure data is sorted by time
    data.sort((a, b) => (a.time as number) - (b.time as number));

    seriesRef.current?.setData(data);
    chartRef.current?.timeScale().fitContent();

  }, [history]);

  useEffect(() => {
    return () => {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, []);

  if (loading) return <div className="p-6 border rounded-xl text-center">Loading Equity Curve...</div>;
  if (error) return <div className="p-6 border rounded-xl text-center text-red-500">{error}</div>;
  if (history.length === 0) {
    return (
      <div className="p-6 border rounded-xl bg-card">
        <h3 className="font-semibold text-lg mb-4">Portfolio Equity Curve</h3>
        <div className="flex items-center justify-center h-[300px] text-muted-foreground">
          No historical data available. End of day snapshots will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 border rounded-xl bg-card shadow">
      <h3 className="font-semibold text-lg mb-4">Portfolio Equity Curve</h3>
      <div ref={chartContainerRef} className="h-[300px] w-full" />
    </div>
  );
}
