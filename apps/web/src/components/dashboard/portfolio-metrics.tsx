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
  const lockedCash = parseFloat(metrics.lockedCash);
  const availableCash = totalCash - lockedCash;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Total Value</h3>
        <p className="text-3xl font-bold">${totalCash.toFixed(2)}</p>
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Available Cash</h3>
        <p className="text-3xl font-bold text-green-500">${availableCash.toFixed(2)}</p>
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Locked Cash</h3>
        <p className="text-3xl font-bold text-amber-500">${lockedCash.toFixed(2)}</p>
      </div>
    </div>
  );
}
