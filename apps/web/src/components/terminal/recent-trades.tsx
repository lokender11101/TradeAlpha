'use client';

import { useEffect, useState } from 'react';
import { useSocket } from '@/lib/socket-context';
import { useAuth } from '@/lib/auth-context';

interface Trade {
  id: string;
  symbol: string;
  side: string;
  price: string;
  quantity: string;
  timestamp: string;
}

export function RecentTrades() {
  const { socket, connected } = useSocket();
  const { user } = useAuth();
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    if (!socket || !connected || !user?.portfolioId) return;

    socket.emit('join_portfolio', user.portfolioId, (res: any) => {
      if (!res?.success) console.error('Failed to join portfolio:', res?.error);
    });

    const handleFilled = (envelope: any) => {
      const payload = envelope.payload;
      const newTrade: Trade = {
        id: envelope.eventId,
        symbol: payload.symbol,
        side: payload.side,
        price: payload.price,
        quantity: payload.filledQuantity,
        timestamp: new Date().toISOString()
      };
      setTrades(prev => [newTrade, ...prev].slice(0, 50));
    };

    socket.on('ORDER_FILLED', handleFilled);
    
    // Also listen to partial fills
    socket.on('ORDER_PARTIALLY_FILLED', handleFilled);

    return () => {
      socket.off('ORDER_FILLED', handleFilled);
      socket.off('ORDER_PARTIALLY_FILLED', handleFilled);
    };
  }, [socket, connected, user]);

  return (
    <div className="p-4 border rounded-xl bg-card text-card-foreground">
      <h3 className="font-semibold text-lg mb-4">My Recent Trades</h3>
      <div className="flex flex-col text-sm font-mono overflow-y-auto max-h-[300px]">
        <div className="grid grid-cols-4 text-muted-foreground pb-2 border-b mb-2">
          <div className="text-left">Symbol</div>
          <div className="text-left">Side</div>
          <div className="text-right">Qty</div>
          <div className="text-right">Price</div>
        </div>
        
        <div className="space-y-2">
          {trades.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">No recent trades</p>
          ) : (
            trades.map((trade) => (
              <div key={trade.id} className="grid grid-cols-4 items-center">
                <div className="text-left font-semibold">{trade.symbol}</div>
                <div className={`text-left font-bold ${trade.side === 'BUY' ? 'text-green-500' : 'text-red-500'}`}>
                  {trade.side}
                </div>
                <div className="text-right">{trade.quantity}</div>
                <div className="text-right">{trade.price}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
