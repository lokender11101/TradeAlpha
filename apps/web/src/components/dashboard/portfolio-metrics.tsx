'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { useSocket } from '@/lib/socket-context';

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

  const { socket } = useSocket();

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);

    if (socket) {
      const handleUpdate = () => fetchMetrics();
      socket.on('POSITION_UPDATED', handleUpdate);
      socket.on('ORDER_FILLED', handleUpdate);
      socket.on('PORTFOLIO_UPDATED', handleUpdate);
      
      return () => {
        clearInterval(interval);
        socket.off('POSITION_UPDATED', handleUpdate);
        socket.off('ORDER_FILLED', handleUpdate);
        socket.off('PORTFOLIO_UPDATED', handleUpdate);
      };
    }

    return () => clearInterval(interval);
  }, [fetchMetrics, socket]);

  if (!metrics) return <div>Loading metrics...</div>;

  const totalCash = parseFloat(metrics.totalCash);
  const availableCash = parseFloat(metrics.availableCash);
  const totalNav = parseFloat(metrics.totalNav || metrics.totalCash);
  const unrealizedPnl = parseFloat(metrics.unrealizedPnl || '0');

  return (
    <div className="grid gap-4 md:grid-cols-4">
      {metrics.isMarginEnabled ? (
        <>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6 flex flex-col justify-between">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-semibold leading-none tracking-tight text-muted-foreground">Equity</h3>
              <span className={`text-xs px-2 py-1 rounded font-bold ${metrics.marginStatus === 'MARGIN_CALL' ? 'bg-red-200 text-red-900' : 'bg-green-100 text-green-800'}`}>
                {metrics.marginStatus}
              </span>
            </div>
            <p className="text-3xl font-bold">${totalNav.toFixed(2)}</p>
            {metrics.isStale && <p className="text-xs text-yellow-500 mt-1">Pricing data may be stale</p>}
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Free Margin</h3>
            <p className="text-3xl font-bold">${parseFloat(metrics.freeMargin || '0').toFixed(2)}</p>
            <p className="text-xs text-muted-foreground mt-2">Buying Power: ${parseFloat(metrics.buyingPower || '0').toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Used Margin</h3>
            <p className="text-3xl font-bold">${parseFloat(metrics.usedMargin || '0').toFixed(2)}</p>
            <p className="text-xs text-muted-foreground mt-2">Locked: ${parseFloat(metrics.lockedMargin || '0').toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Margin Level</h3>
            <p className={`text-3xl font-bold ${metrics.marginStatus === 'MARGIN_CALL' ? 'text-red-500' : ''}`}>
              {metrics.marginLevel ? `${parseFloat(metrics.marginLevel).toFixed(2)}%` : 'N/A'}
            </p>
            <p className="text-xs text-muted-foreground mt-2">Maint Req: ${parseFloat(metrics.maintenanceMargin || '0').toFixed(2)}</p>
          </div>
        </>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
