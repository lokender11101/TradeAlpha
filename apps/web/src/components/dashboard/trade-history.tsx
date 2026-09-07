'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';

export function TradeHistory() {
  const { user } = useAuth();
  const [fills, setFills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 10;

  const fetchFills = useCallback(async () => {
    if (!user?.portfolioId) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/portfolios/${user.portfolioId}/fills?page=${page}&limit=${limit}`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setFills(data.data || []);
        setTotal(data.total || 0);
        setError(false);
      } else {
        setError(true);
      }
    } catch (err) {
      console.error('Failed to fetch fills', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [user, page]);

  useEffect(() => {
    fetchFills();
  }, [fetchFills]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow mt-8">
      <div className="p-6 pb-2">
        <h3 className="font-semibold text-lg">Execution History</h3>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Fee</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && fills.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-6" aria-live="polite">
                  Loading trade history...
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-red-500 py-6" aria-live="assertive">
                  Failed to load trade history.
                </TableCell>
              </TableRow>
            ) : fills.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                  No trades executed yet.
                </TableCell>
              </TableRow>
            ) : (
              fills.map((fill) => (
                <TableRow key={fill.id}>
                  <TableCell className="whitespace-nowrap">{new Date(fill.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="font-medium">{fill.order?.symbol}</TableCell>
                  <TableCell>
                    <span className={`text-xs px-2 py-1 rounded-sm font-semibold ${fill.order?.side === 'BUY' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {fill.order?.side}
                    </span>
                  </TableCell>
                  <TableCell>{fill.order?.type}</TableCell>
                  <TableCell className="text-right">{parseFloat(fill.quantity).toFixed(4)}</TableCell>
                  <TableCell className="text-right">${parseFloat(fill.price).toFixed(2)}</TableCell>
                  <TableCell className="text-right">${parseFloat(fill.fee || '0').toFixed(2)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {totalPages > 1 && (
        <div className="p-4 border-t flex justify-end items-center gap-4">
          <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1 || loading}>
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
          <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages || loading}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
