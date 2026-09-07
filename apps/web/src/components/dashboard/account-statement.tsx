'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';

export function AccountStatement() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 10;

  const fetchEntries = useCallback(async () => {
    if (!user?.portfolioId) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/portfolios/${user.portfolioId}/ledger?page=${page}&limit=${limit}`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setEntries(data.data || []);
        setTotal(data.total || 0);
        setError(false);
      } else {
        setError(true);
      }
    } catch (err) {
      console.error('Failed to fetch ledger entries', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [user, page]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow mt-8">
      <div className="p-6 pb-2">
        <h3 className="font-semibold text-lg">Account Statement</h3>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Entry Type</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead className="text-right">Credit / Debit</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-6" aria-live="polite">
                  Loading account statement...
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-red-500 py-6" aria-live="assertive">
                  Failed to load account statement.
                </TableCell>
              </TableRow>
            ) : entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                  No ledger entries found.
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => {
                const isCredit = entry.entryType === 'CREDIT';
                const amount = parseFloat(entry.amount);
                return (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap">{new Date(entry.createdAt).toLocaleString()}</TableCell>
                    <TableCell>{entry.accountType}</TableCell>
                    <TableCell>
                      <span className={`text-xs px-2 py-1 rounded-sm font-semibold ${isCredit ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {entry.entryType}
                      </span>
                    </TableCell>
                    <TableCell>{entry.assetSymbol}</TableCell>
                    <TableCell className={`text-right font-medium ${isCredit ? 'text-green-600' : 'text-red-600'}`}>
                      {isCredit ? '+' : '-'}${amount.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-medium">${parseFloat(entry.postBalance || '0').toFixed(2)}</TableCell>
                  </TableRow>
                );
              })
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
