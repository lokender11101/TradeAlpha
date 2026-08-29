const fs = require('fs');
const file = 'apps/web/src/components/dashboard/positions-table.tsx';
let code = fs.readFileSync(file, 'utf8');

const newCode = `'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { useSocket } from '@/lib/socket-context';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function PositionsTable() {
  const { user } = useAuth();
  const [positions, setPositions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchPositions = useCallback(async () => {
    if (!user?.portfolioId) return;
    try {
      const res = await apiFetch('/portfolios/' + user.portfolioId + '/positions', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setPositions(data);
        setError(false);
      } else {
        setError(true);
      }
    } catch (err) {
      console.error('Failed to fetch positions', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  const { socket } = useSocket();

  useEffect(() => {
    fetchPositions();

    if (socket) {
      const handleUpdate = () => fetchPositions();
      socket.on('POSITION_UPDATED', handleUpdate);
      socket.on('ORDER_FILLED', handleUpdate);
      socket.on('MARKET_TICK', handleUpdate);
      socket.on('connect', handleUpdate);
      
      return () => {
        socket.off('POSITION_UPDATED', handleUpdate);
        socket.off('ORDER_FILLED', handleUpdate);
        socket.off('MARKET_TICK', handleUpdate);
        socket.off('connect', handleUpdate);
      };
    }
  }, [fetchPositions, socket]);

  if (loading) return <div aria-live="polite">Loading positions...</div>;
  if (error) return <div aria-live="assertive" className="text-red-500">Unavailable / Loading</div>;

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow">
      <div className="p-6 pb-2">
        <h3 className="font-semibold text-lg">Portfolio Positions</h3>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead className="text-right">Qty & Side</TableHead>
            <TableHead className="text-right">Avg Entry</TableHead>
            <TableHead className="text-right">Current Price</TableHead>
            <TableHead className="text-right">Market Value / Liability</TableHead>
            <TableHead className="text-right">Unrealized PnL</TableHead>
            <TableHead className="text-right">Realized PnL</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                No active positions
              </TableCell>
            </TableRow>
          ) : (
            positions.map((pos, idx) => {
              const uPnlNum = parseFloat(pos.unrealizedPnl || '0');
              const rPnlNum = parseFloat(pos.realizedPnl || '0');
              const qtyNum = parseFloat(pos.quantity || '0');
              
              return (
                <TableRow key={idx}>
                  <TableCell className="font-medium">{pos.symbol}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end items-center space-x-2">
                      <span>{Math.abs(qtyNum).toString()}</span>
                      <span 
                        className={\`text-xs px-1.5 py-0.5 rounded-sm font-semibold \${qtyNum >= 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}\`}
                        aria-label={\`Side: \${qtyNum >= 0 ? "LONG" : "SHORT"}\`}
                      >
                        {qtyNum >= 0 ? "LONG" : "SHORT"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{parseFloat(pos.averageEntryPrice).toFixed(2)}</TableCell>
                  <TableCell className="text-right">
                    {pos.currentPrice ? (
                      <span className={pos.isStale ? 'text-muted-foreground' : ''}>
                        {parseFloat(pos.currentPrice).toFixed(2)}
                        {pos.isStale && <span className="sr-only"> (stale)</span>}
                      </span>
                    ) : (
                      '---'
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {pos.totalValue ? (
                      <span className={pos.isStale ? 'text-muted-foreground' : ''}>
                        \${Math.abs(parseFloat(pos.totalValue)).toFixed(2)}
                      </span>
                    ) : (
                      '---'
                    )}
                  </TableCell>
                  <TableCell className={\`text-right \${pos.isStale ? 'text-muted-foreground' : (uPnlNum > 0 ? 'text-green-500' : uPnlNum < 0 ? 'text-red-500' : '')}\`}>
                    {pos.unrealizedPnl ? (
                      <span>
                        {uPnlNum < 0 ? '-' : ''}\${Math.abs(uPnlNum).toFixed(2)}
                      </span>
                    ) : (
                      '---'
                    )}
                  </TableCell>
                  <TableCell className={\`text-right \${rPnlNum > 0 ? 'text-green-500' : rPnlNum < 0 ? 'text-red-500' : ''}\`}>
                    {rPnlNum < 0 ? '-' : ''}\${Math.abs(rPnlNum).toFixed(2)}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
`;

fs.writeFileSync(file, newCode);
