'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { useSocket } from '@/lib/socket-context';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function PositionsTable() {
  const { user } = useAuth();
  const [positions, setPositions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPositions = useCallback(async () => {
    if (!user?.portfolioId) return;
    try {
      const res = await apiFetch(`/portfolios/${user.portfolioId}/positions`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setPositions(data);
      }
    } catch (err) {
      console.error('Failed to fetch positions', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  const { socket } = useSocket();

  useEffect(() => {
    fetchPositions();
    const interval = setInterval(fetchPositions, 5000);

    if (socket) {
      const handleUpdate = () => fetchPositions();
      socket.on('POSITION_UPDATED', handleUpdate);
      socket.on('ORDER_FILLED', handleUpdate);
      socket.on('MARKET_TICK', handleUpdate);
      
      return () => {
        clearInterval(interval);
        socket.off('POSITION_UPDATED', handleUpdate);
        socket.off('ORDER_FILLED', handleUpdate);
        socket.off('MARKET_TICK', handleUpdate);
      };
    }

    return () => clearInterval(interval);
  }, [fetchPositions, socket]);

  if (loading) return <div>Loading positions...</div>;

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow">
      <div className="p-6 pb-2">
        <h3 className="font-semibold text-lg">Portfolio Positions</h3>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Avg Entry</TableHead>
            <TableHead className="text-right">Current Price</TableHead>
            <TableHead className="text-right">Total Value</TableHead>
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
              const rPnlNum = parseFloat(pos.realizedPnl);
              
              return (
                <TableRow key={idx}>
                  <TableCell className="font-medium">{pos.symbol}</TableCell>
                  <TableCell className="text-right"><div className="flex justify-end items-center space-x-2"><span>{Math.abs(parseFloat(pos.quantity))}</span><span className={`text-xs px-1.5 py-0.5 rounded-sm font-semibold ${parseFloat(pos.quantity) >= 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>{parseFloat(pos.quantity) >= 0 ? "LONG" : "SHORT"}</span></div></TableCell>
                  <TableCell className="text-right">{parseFloat(pos.averageEntryPrice).toFixed(2)}</TableCell>
                  <TableCell className="text-right">
                    {pos.currentPrice ? (
                      <span className={pos.isStale ? 'text-muted-foreground' : ''}>
                        {parseFloat(pos.currentPrice).toFixed(2)}
                        {pos.isStale && ' (stale)'}
                      </span>
                    ) : (
                      '---'
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {pos.totalValue ? (
                      <span className={pos.isStale ? 'text-muted-foreground' : ''}>
                        ${parseFloat(pos.totalValue).toFixed(2)}
                      </span>
                    ) : (
                      '---'
                    )}
                  </TableCell>
                  <TableCell className={`text-right ${pos.isStale ? 'text-muted-foreground' : (uPnlNum > 0 ? 'text-green-500' : uPnlNum < 0 ? 'text-red-500' : '')}`}>
                    {pos.unrealizedPnl ? (
                      <span>
                        ${uPnlNum.toFixed(2)}
                        {pos.isStale && ' (stale)'}
                      </span>
                    ) : (
                      '---'
                    )}
                  </TableCell>
                  <TableCell className={`text-right ${rPnlNum > 0 ? 'text-green-500' : rPnlNum < 0 ? 'text-red-500' : ''}`}>
                    ${rPnlNum.toFixed(2)}
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
