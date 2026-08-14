'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';

export function PortfolioMetrics() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<any>(null);

  const fetchMetrics = async () => {
    if (!user?.portfolioId) return;
    try {
      const res = await apiFetch(`/portfolio/${user.portfolioId}`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch (err) {
      console.error('Failed to fetch metrics', err);
    }
  };

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [user]);

  if (!metrics) return <div>Loading metrics...</div>;

  const totalValue = parseFloat(metrics.availableCash) + parseFloat(metrics.lockedCash); // Simplification

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Total Cash</h3>
        <p className="text-3xl font-bold">${totalValue.toFixed(2)}</p>
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Available Cash</h3>
        <p className="text-3xl font-bold text-green-500">${parseFloat(metrics.availableCash).toFixed(2)}</p>
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Locked Cash</h3>
        <p className="text-3xl font-bold text-amber-500">${parseFloat(metrics.lockedCash).toFixed(2)}</p>
      </div>
    </div>
  );
}
