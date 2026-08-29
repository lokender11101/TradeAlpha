const fs = require('fs');
const file = 'apps/web/src/components/dashboard/open-orders.tsx';
let code = fs.readFileSync(file, 'utf8');

const newCode = `'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { useSocket } from '@/lib/socket-context';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function OpenOrders() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await apiFetch('/orders?status=PENDING&status=PARTIALLY_FILLED', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setOrders(data.data || []);
        setError(false);
      } else {
        setError(true);
      }
    } catch (err) {
      console.error('Failed to fetch open orders', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const { socket } = useSocket();

  useEffect(() => {
    fetchOrders();

    if (socket) {
      const handleOrderUpdate = () => fetchOrders();
      socket.on('ORDER_ACCEPTED', handleOrderUpdate);
      socket.on('ORDER_PENDING', handleOrderUpdate);
      socket.on('ORDER_FILLED', handleOrderUpdate);
      socket.on('ORDER_PARTIALLY_FILLED', handleOrderUpdate);
      socket.on('ORDER_CANCELLED', handleOrderUpdate);
      socket.on('ORDER_EXPIRED', handleOrderUpdate);
      socket.on('connect', handleOrderUpdate);
      
      return () => {
        socket.off('ORDER_ACCEPTED', handleOrderUpdate);
        socket.off('ORDER_PENDING', handleOrderUpdate);
        socket.off('ORDER_FILLED', handleOrderUpdate);
        socket.off('ORDER_PARTIALLY_FILLED', handleOrderUpdate);
        socket.off('ORDER_CANCELLED', handleOrderUpdate);
        socket.off('ORDER_EXPIRED', handleOrderUpdate);
        socket.off('connect', handleOrderUpdate);
      };
    }
  }, [fetchOrders, socket]);

  const handleCancel = async (orderId: string) => {
    try {
      const res = await apiFetch(\`/orders/\${orderId}\`, { method: 'DELETE' });
      if (res.ok) {
        fetchOrders();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to cancel');
      }
    } catch (err) {
      alert('Network error during cancellation');
    }
  };

  if (loading) return <div aria-live="polite">Loading open orders...</div>;
  if (error) return <div aria-live="assertive" className="text-red-500">Unavailable / Loading</div>;

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow">
      <div className="p-6 pb-2">
        <h3 className="font-semibold text-lg">Open Orders</h3>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                No open orders found
              </TableCell>
            </TableRow>
          ) : (
            orders.map(order => (
              <TableRow key={order.id}>
                <TableCell className="font-medium">
                  {order.symbol}
                  {order.isLiquidation && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded-sm bg-red-100 text-red-700 font-semibold" aria-label="Liquidation Order">
                      LIQUIDATION
                    </span>
                  )}
                </TableCell>
                <TableCell>{order.type}</TableCell>
                <TableCell>
                  <span className={order.side === 'BUY' ? 'text-green-500' : 'text-red-500'}>
                    {order.side}
                  </span>
                </TableCell>
                <TableCell>{order.status}</TableCell>
                <TableCell className="text-right">
                  {order.filledQuantity} / {order.requestedQuantity}
                </TableCell>
                <TableCell className="text-right">
                  {order.price || 'Market'}
                </TableCell>
                <TableCell className="text-right">
                  {!order.isLiquidation && (
                    <Button variant="destructive" size="sm" onClick={() => handleCancel(order.id)}>
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
`;

fs.writeFileSync(file, newCode);
