'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function OrderEntry({ symbol }: { symbol: string }) {
  const { user } = useAuth();
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [type, setType] = useState<'MARKET' | 'LIMIT'>('LIMIT');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const submitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    
    setLoading(true);
    setMessage('');
    try {
      const payload: any = {
        symbol,
        side,
        type,
        requestedQuantity: Number(quantity),
        idempotencyKey: crypto.randomUUID(),
        currentMarketPrice: type === 'MARKET' ? 100 : Number(price), // Defaulting for market, usually from live feed
        // API will need to fallback to user's portfolio if missing, or we send it here
      };
      if (type === 'LIMIT') {
        payload.limitPrice = Number(price);
      }

      const res = await apiFetch('/orders', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      
      const data = await res.json();
      if (res.ok) {
        setMessage(`Order accepted: ${data.id}`);
        setQuantity('');
        setPrice('');
      } else {
        setMessage(`Error: ${data.error || 'Failed'}`);
      }
    } catch (_err) {
      setMessage('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 border rounded-xl bg-card text-card-foreground">
      <h3 className="font-semibold text-lg mb-4">Order Entry - {symbol}</h3>
      <form onSubmit={submitOrder} className="space-y-4">
        <div className="flex space-x-2">
          <Button 
            type="button" 
            variant={side === 'BUY' ? 'default' : 'outline'}
            className={side === 'BUY' ? 'bg-green-600 hover:bg-green-700 text-white w-full' : 'w-full'}
            onClick={() => setSide('BUY')}
          >
            Buy
          </Button>
          <Button 
            type="button" 
            variant={side === 'SELL' ? 'default' : 'outline'}
            className={side === 'SELL' ? 'bg-red-600 hover:bg-red-700 text-white w-full' : 'w-full'}
            onClick={() => setSide('SELL')}
          >
            Sell
          </Button>
        </div>

        <div className="flex space-x-2">
          <Button 
            type="button" 
            variant={type === 'MARKET' ? 'secondary' : 'outline'}
            size="sm"
            className="w-full text-xs"
            onClick={() => setType('MARKET')}
          >
            Market
          </Button>
          <Button 
            type="button" 
            variant={type === 'LIMIT' ? 'secondary' : 'outline'}
            size="sm"
            className="w-full text-xs"
            onClick={() => setType('LIMIT')}
          >
            Limit
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="qty">Quantity</Label>
          <Input id="qty" type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
        </div>

        {type === 'LIMIT' && (
          <div className="space-y-2">
            <Label htmlFor="price">Price</Label>
            <Input id="price" type="number" step="0.01" min="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </div>
        )}

        <Button type="submit" className="w-full mt-4" disabled={loading || !user}>
          {loading ? 'Submitting...' : `Place ${side} Order`}
        </Button>
        
        {message && (
          <p className="text-sm mt-2 text-center text-muted-foreground">{message}</p>
        )}
      </form>
    </div>
  );
}
