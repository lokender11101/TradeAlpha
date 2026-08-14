'use client';

import { useEffect, useState } from 'react';
import { useSocket } from '@/lib/socket-context';

interface OrderBookLevel {
  price: string;
  size: string;
  total: string;
}

export function OrderBook({ symbol }: { symbol: string }) {
  const { socket, connected } = useSocket();
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);

  useEffect(() => {
    if (!socket || !connected) return;

    const handleTick = (tick: any) => {
      if (tick.symbol === symbol) {
        setCurrentPrice(parseFloat(tick.price));
      }
    };

    socket.on('market:tick', handleTick);
    
    // Subscribe to symbol if backend requires it (optional depending on implementation)
    // socket.emit('subscribe', symbol);

    return () => {
      socket.off('market:tick', handleTick);
    };
  }, [socket, connected, symbol]);

  // Generate simulated order book levels around current price
  const generateLevels = (price: number | null, isAsk: boolean): OrderBookLevel[] => {
    if (!price) return Array(5).fill({ price: '-', size: '-', total: '-' });
    
    const levels: OrderBookLevel[] = [];
    let totalSize = 0;
    
    for (let i = 0; i < 5; i++) {
      // Asks go up from price, Bids go down from price
      const offset = (i + 1) * 0.05;
      const levelPrice = isAsk ? price + offset : price - offset;
      
      // Random deterministic-ish size
      const size = Math.floor(Math.abs(Math.sin(levelPrice * 100)) * 500) + 50;
      totalSize += size;
      
      levels.push({
        price: levelPrice.toFixed(2),
        size: size.toString(),
        total: totalSize.toString()
      });
    }

    // Bids should be highest price first (i=0 is highest bid)
    // Asks are usually displayed lowest price first (i=0 is lowest ask), 
    // but in an order book, asks are often rendered top-down (highest ask at the top).
    if (isAsk) {
      return levels.reverse(); 
    }
    
    return levels;
  };

  const asks = generateLevels(currentPrice, true);
  const bids = generateLevels(currentPrice, false);

  return (
    <div className="p-4 border rounded-xl bg-card text-card-foreground">
      <h3 className="font-semibold text-lg mb-4">Order Book - {symbol}</h3>
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
          <span className={currentPrice ? 'text-primary' : 'text-muted-foreground'}>
            {currentPrice ? currentPrice.toFixed(2) : '---'}
          </span>
          <span className="text-xs font-normal text-muted-foreground uppercase">Spread: 0.10</span>
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
