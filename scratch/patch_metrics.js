const fs = require('fs');
const file = 'apps/web/src/components/dashboard/portfolio-metrics.tsx';

const newCode = `'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { useSocket } from '@/lib/socket-context';

export function PortfolioMetrics() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchMetrics = useCallback(async () => {
    if (!user?.portfolioId) return;
    try {
      const res = await apiFetch('/portfolios/' + user.portfolioId, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
        setError(false);
      } else {
        setError(true);
      }
    } catch (err) {
      console.error('Failed to fetch metrics', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  const { socket, isConnected } = useSocket();

  useEffect(() => {
    fetchMetrics();

    if (socket) {
      const handleUpdate = () => fetchMetrics();
      socket.on('POSITION_UPDATED', handleUpdate);
      socket.on('ORDER_FILLED', handleUpdate);
      socket.on('PORTFOLIO_UPDATED', handleUpdate);
      socket.on('connect', handleUpdate);
      
      return () => {
        socket.off('POSITION_UPDATED', handleUpdate);
        socket.off('ORDER_FILLED', handleUpdate);
        socket.off('PORTFOLIO_UPDATED', handleUpdate);
        socket.off('connect', handleUpdate);
      };
    }
  }, [fetchMetrics, socket]);

  if (loading) return <div aria-live="polite">Loading portfolio data...</div>;
  if (error || !metrics) return <div aria-live="assertive" className="text-red-500">Unavailable / Loading</div>;

  const totalNav = metrics.totalNav;
  const totalCash = metrics.totalCash;
  const availableCash = metrics.availableCash;
  const unrealizedPnl = metrics.unrealizedPnl || '0';

  return (
    <div className="space-y-4">
      {!isConnected && (
        <div className="bg-yellow-100 text-yellow-800 p-2 rounded text-sm text-center" aria-live="polite">
          Disconnected from live feed. Reconnecting...
        </div>
      )}
      
      {metrics.marginStatus === 'FORCED_LIQUIDATION' && (
        <div className="bg-red-600 text-white p-4 rounded-xl font-bold text-center uppercase tracking-wider shadow-lg" aria-live="assertive" role="alert">
          Forced liquidation in progress
        </div>
      )}
      
      {metrics.isMarginEnabled ? (
        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6 flex flex-col justify-between col-span-full md:col-span-2">
            <div className="flex justify-between items-start mb-2">
              <div>
                <h3 className="font-semibold leading-none tracking-tight text-muted-foreground">Equity / NAV</h3>
                <p className="text-4xl font-bold mt-2">\${parseFloat(totalNav).toFixed(2)}</p>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-sm font-medium text-muted-foreground mb-1" aria-label="Margin Status">Margin Status</span>
                <span 
                  className={\`text-sm px-3 py-1 rounded font-bold \${
                    metrics.marginStatus === 'NORMAL' ? 'bg-green-100 text-green-800' : 
                    metrics.marginStatus === 'MARGIN_CALL' ? 'bg-yellow-200 text-yellow-900' : 
                    'bg-red-200 text-red-900'
                  }\`}
                  aria-label={\`Current status: \${metrics.marginStatus}\`}
                >
                  {metrics.marginStatus ? metrics.marginStatus.replace('_', ' ') : 'NORMAL'}
                </span>
              </div>
            </div>
            {metrics.isStale && <p className="text-xs text-yellow-500 mt-1">Pricing data may be stale</p>}
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Margin Level</h3>
            <p className={\`text-2xl font-bold \${metrics.marginStatus === 'MARGIN_CALL' ? 'text-yellow-600' : metrics.marginStatus === 'FORCED_LIQUIDATION' ? 'text-red-600' : ''}\`}>
              {metrics.marginLevel ? \`\${parseFloat(metrics.marginLevel).toFixed(2)}%\` : 'N/A'}
            </p>
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Buying Power</h3>
            <p className="text-2xl font-bold">\${parseFloat(metrics.buyingPower || '0').toFixed(2)}</p>
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Total Cash</h3>
            <p className="text-lg font-bold">\${parseFloat(totalCash || '0').toFixed(2)}</p>
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Long Market Value</h3>
            <p className="text-lg font-bold">\${parseFloat(metrics.longMarketValue || '0').toFixed(2)}</p>
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Short Liability</h3>
            <p className="text-lg font-bold">\${parseFloat(metrics.shortLiabilityValue || '0').toFixed(2)}</p>
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Gross Exposure</h3>
            <p className="text-lg font-bold">\${parseFloat(metrics.grossExposure || '0').toFixed(2)}</p>
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Initial Margin</h3>
            <p className="text-lg font-bold">\${parseFloat(metrics.initialMargin || '0').toFixed(2)}</p>
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Maintenance Margin</h3>
            <p className="text-lg font-bold">\${parseFloat(metrics.maintenanceMargin || '0').toFixed(2)}</p>
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Used Margin</h3>
            <p className="text-lg font-bold">\${parseFloat(metrics.usedMargin || '0').toFixed(2)}</p>
          </div>

          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Free Margin</h3>
            <p className="text-lg font-bold">\${parseFloat(metrics.freeMargin || '0').toFixed(2)}</p>
          </div>
          
          <div className="rounded-xl border bg-card text-card-foreground shadow p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-1">Locked Margin</h3>
            <p className="text-lg font-bold">\${parseFloat(metrics.lockedMargin || '0').toFixed(2)}</p>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Equity / NAV</h3>
            <p className="text-3xl font-bold">\${parseFloat(totalNav).toFixed(2)}</p>
            {metrics.isStale && <p className="text-xs text-yellow-500 mt-1">Pricing data may be stale</p>}
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Total Cash</h3>
            <p className="text-3xl font-bold">\${parseFloat(totalCash).toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Available Cash</h3>
            <p className="text-3xl font-bold">\${parseFloat(availableCash).toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Unrealized P&L</h3>
            <p className={\`text-3xl font-bold \${parseFloat(unrealizedPnl) > 0 ? 'text-green-500' : parseFloat(unrealizedPnl) < 0 ? 'text-red-500' : ''}\`}>
              {parseFloat(unrealizedPnl) < 0 ? '-' : ''}\${Math.abs(parseFloat(unrealizedPnl)).toFixed(2)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
`;

fs.writeFileSync(file, newCode);
