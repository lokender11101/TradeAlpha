'use client';

import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface ApiKey {
  name?: string;
  id: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
}

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const fetchKeys = async () => {
    try {
      const res = await apiFetch('/keys', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setKeys(data);
      } else {
        setError('Failed to fetch API keys');
      }
    } catch (err) {
      setError('Network error loading API keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setNewSecret(null);
    try {
      const res = await apiFetch('/keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName, scopes: ['orders:read', 'orders:write', 'portfolio:read'] })
      });
      const data = await res.json();
      if (res.ok) {
        setNewSecret(data.plaintextSecret);
        setNewKeyName('');
        fetchKeys();
      } else {
        setError(data.error || 'Failed to create key');
      }
    } catch (err) {
      setError('Network error creating key');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this API key? Any applications using it will immediately lose access.')) return;
    try {
      const res = await apiFetch('/keys/' + id, { method: 'DELETE' });
      if (res.ok) {
        fetchKeys();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to revoke key');
      }
    } catch (err) {
      setError('Network error revoking key');
    }
  };

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow">
      <div className="p-6 border-b">
        <h2 className="text-xl font-semibold mb-2">API Keys</h2>
        <p className="text-sm text-muted-foreground mb-4">
          API keys allow you to programmatically access the TradeAlpha API. Use them to place orders and retrieve market data.
        </p>

        {error && <div className="mb-4 text-red-500 text-sm p-3 bg-red-50 rounded" aria-live="assertive">{error}</div>}

        {newSecret && (
          <div className="mb-6 p-4 border border-green-200 bg-green-50 rounded-lg" aria-live="polite">
            <h3 className="text-green-800 font-semibold mb-2">Key Created Successfully</h3>
            <p className="text-sm text-green-700 mb-2">
              Please copy your new API secret. <strong>It will never be shown again.</strong>
            </p>
            <div className="bg-white p-2 rounded border break-all font-mono text-sm select-all">
              {newSecret}
            </div>
          </div>
        )}

        <form onSubmit={handleCreate} className="flex gap-4 items-end">
          <div className="flex-1 max-w-xs">
            <label htmlFor="keyName" className="block text-sm font-medium mb-1">New Key Label</label>
            <Input 
              id="keyName" 
              placeholder="e.g. Trading Bot Prod" 
              value={newKeyName} 
              onChange={(e) => setNewKeyName(e.target.value)} 
              required
            />
          </div>
          <Button type="submit" disabled={creating}>
            {creating ? 'Creating...' : 'Create API Key'}
          </Button>
        </form>
      </div>

      <div className="p-0">
        {loading ? (
          <div className="p-6 text-center text-muted-foreground" aria-live="polite">Loading API keys...</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Created At</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                    No active API keys found.
                  </TableCell>
                </TableRow>
              ) : (
                keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>{k.name || 'Unnamed Key'}</TableCell>
                    <TableCell className="font-mono">{k.keyPrefix}...</TableCell>
                    <TableCell>{k.scopes.join(', ')}</TableCell>
                    <TableCell>{new Date(k.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="destructive" size="sm" onClick={() => handleRevoke(k.id)}>
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
