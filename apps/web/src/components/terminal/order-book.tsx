'use client';

import { useEffect, useState } from 'react';
import { useSocket } from '@/lib/socket-context';
import { apiFetch } from '@/lib/api';

interface OrderBookLevel {
  price: string;
  size: string;
  total: string;
}

interface ExecutionProfile {
  symbol: string;
  baseSpread: string;
  availableDepth: string;
  slippageFactor: string;
}

export function OrderBook({ symbol }: { symbol: string }) {
  const { socket, connected } = useSocket();
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [profile, setProfile] = useState<ExecutionProfile | null>(null);

  useEffect(() => {
    apiFetch(`/market/execution-profile?symbol=${symbol}`)
      .then(r => r.json())
      .then(p => {
        if (!p.error) setProfile(p);
      })
      .catch(console.error);
  }, [symbol]);

  useEffect(() => {
    if (!socket || !connected) return;

    const handleTick = (tick: any) => {
      if (tick.symbol === symbol) {
        setCurrentPrice(parseFloat(tick.price));
      }
    };

    socket.on('market:tick', handleTick);
    socket.emit('join_market', symbol);

    return () => {
      socket.off('market:tick', handleTick);
      socket.emit('leave_market', symbol);
    };
  }, [socket, connected, symbol]);

  const generateLevels = (price: number | null, isAsk: boolean): OrderBookLevel[] => {
    if (!price || !profile) return Array(5).fill({ price: '-', size: '-', total: '-' });
    
    const levels: OrderBookLevel[] = [];
    let totalSize = 0;
    
    const baseSpread = parseFloat(profile.baseSpread);
    const slippage = parseFloat(profile.slippageFactor);
    const depth = parseInt(profile.availableDepth, 10);
    
    for (let i = 0; i < 5; i++) {
      const spreadOffset = baseSpread / 2;
      const slippageOffset = i * slippage;
      const totalOffset = spreadOffset + slippageOffset;
      const levelPrice = isAsk ? price + totalOffset : price - totalOffset;
      
      const size = depth;
      totalSize += size;
      
      levels.push({
        price: levelPrice.toFixed(2),
        size: size.toString(),
        total: totalSize.toString()
      });
    }

    if (isAsk) {
      return levels.reverse(); 
    }
    
    return levels;
  };

  const asks = generateLevels(currentPrice, true);
  const bids = generateLevels(currentPrice, false);

  return (
    <div className="p-4 border rounded-xl bg-card text-card-foreground">
      <h3 className="font-semibold text-lg mb-4">Simulated Market Depth - {symbol}</h3>
      <div className="flex flex-col text-sm font-mono">
        <div className="grid grid-cols-3 text-muted-foreground pb-2 border-b">
          <div className="text-left">Price</div>
          <div className="text-right">Size</div>
          <div className="text-right">Total</div>
        </div>
        
        {/* Asks (Red) */}
        <div className="py-2 space-y-1">
          {asks.map((ask, i) => (
            <div key={`ask-${i}`} className="grid grid-cols-3 text-red-500 hover:bg-red-500/10 cursor-pointer">
              <div className="text-left">{ask.price}</div>
              <div className="text-right">{ask.size}</div>
              <div className="text-right">{ask.total}</div>
            </div>
          ))}
        </div>

        {/* Current Price */}
        <div className="py-2 border-y my-1 flex items-center justify-between font-bold text-lg">
          <span data-testid="live-price" className={currentPrice ? 'text-primary' : 'text-muted-foreground'}>
            {currentPrice ? currentPrice.toFixed(2) : '---'}
          </span>
          <span className="text-xs font-normal text-muted-foreground uppercase">
            Spread: {profile ? profile.baseSpread : '---'}
          </span>
        </div>

        {/* Bids (Green) */}
        <div className="py-2 space-y-1">
          {bids.map((bid, i) => (
            <div key={`bid-${i}`} className="grid grid-cols-3 text-green-500 hover:bg-green-500/10 cursor-pointer">
              <div className="text-left">{bid.price}</div>
              <div className="text-right">{bid.size}</div>
              <div className="text-right">{bid.total}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
