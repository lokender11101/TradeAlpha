'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useSocket } from '@/lib/socket-context';
import { OrderEntry } from '@/components/terminal/order-entry';
import { OrderBook } from '@/components/terminal/order-book';
import { RecentTrades } from '@/components/terminal/recent-trades';

export default function TerminalPage() {
  const { user, loading } = useAuth();
  const { socket, connected } = useSocket();
  const [symbol, setSymbol] = useState('RELIANCE');

  useEffect(() => {
    if (socket && connected) {
      socket.emit('join_market', symbol, (res: any) => {
        if (!res?.success) console.error('Failed to join market:', res?.error);
      });

      return () => {
        socket.emit('leave_market', symbol);
      };
    }
  }, [socket, connected, symbol]);

  if (loading) return <div className="p-8">Loading...</div>;
  if (!user) return null;

  return (
    <div className="flex-1 flex flex-col p-4 md:p-8 h-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-4">
          Trading Terminal
          <select 
            className="text-lg bg-transparent border-b outline-none ml-4"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          >
            <option value="RELIANCE">RELIANCE</option>
            <option value="TCS">TCS</option>
            <option value="INFY">INFY</option>
            <option value="HDFCBANK">HDFCBANK</option>
          </select>
        </h1>
        <div className="flex items-center space-x-2">
          <span className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}></span>
          <span className="text-sm font-medium">{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>
      
      <div className="flex-1 grid gap-4 md:grid-cols-3 lg:grid-cols-4">
        {/* Main Chart Area */}
        <div className="rounded-xl border bg-card text-card-foreground shadow p-6 md:col-span-2 lg:col-span-2 flex flex-col">
          <h3 className="font-semibold text-lg mb-4">Chart - {symbol}</h3>
          <div className="flex-1 flex items-center justify-center bg-muted/20 border border-dashed rounded-lg">
            <p className="text-muted-foreground">Chart Component placeholder</p>
          </div>
        </div>
        
        {/* Order Book */}
        <OrderBook symbol={symbol} />

        {/* Order Entry */}
        <OrderEntry symbol={symbol} />
        {/* Recent Trades */}
        <div className="md:col-span-3 lg:col-span-4">
          <RecentTrades />
        </div>
      </div>
    </div>
  );
}
