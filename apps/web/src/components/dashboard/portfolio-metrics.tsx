'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';

export function PortfolioMetrics() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<any>(null);

  const fetchMetrics = useCallback(async () => {
    if (!user?.portfolioId) return;
    try {
      const res = await apiFetch(`/portfolios/${user.portfolioId}`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch (err) {
      console.error('Failed to fetch metrics', err);
    }
  }, [user]);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  if (!metrics) return <div>Loading metrics...</div>;

  const totalCash = parseFloat(metrics.totalCash);
  const availableCash = parseFloat(metrics.availableCash);
  const totalNav = parseFloat(metrics.totalNav || metrics.totalCash);
  const unrealizedPnl = parseFloat(metrics.unrealizedPnl || '0');

  return (
    <div className="grid gap-4 md:grid-cols-4">
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Net Asset Value (NAV)</h3>
        <p className="text-3xl font-bold">${totalNav.toFixed(2)}</p>
        {metrics.isStale && <p className="text-xs text-yellow-500 mt-1">Pricing data may be stale</p>}
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Total Cash</h3>
        <p className="text-3xl font-bold">${totalCash.toFixed(2)}</p>
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Available Cash</h3>
        <p className="text-3xl font-bold">${availableCash.toFixed(2)}</p>
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Unrealized P&L</h3>
        <p className={`text-3xl font-bold ${unrealizedPnl > 0 ? 'text-green-500' : unrealizedPnl < 0 ? 'text-red-500' : ''}`}>
          {unrealizedPnl < 0 ? '-' : ''}${Math.abs(unrealizedPnl).toFixed(2)}
        </p>
      </div>
    </div>
  );
}
