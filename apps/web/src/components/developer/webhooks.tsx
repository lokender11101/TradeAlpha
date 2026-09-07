'use client';

import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

export function Webhooks() {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState('');

  const fetchWebhooks = async () => {
    try {
      const res = await apiFetch('/webhooks', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setHooks(data);
      } else {
        setError('Failed to fetch webhooks');
      }
    } catch (err) {
      setError('Network error loading webhooks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWebhooks();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      const res = await apiFetch('/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: newUrl, events: ['*'] })
      });
      const data = await res.json();
      if (res.ok) {
        setNewUrl('');
        fetchWebhooks();
      } else {
        setError(data.error || 'Failed to create webhook');
      }
    } catch (err) {
      setError('Network error creating webhook');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this webhook endpoint?')) return;
    try {
      const res = await apiFetch('/webhooks/' + id, { method: 'DELETE' });
      if (res.ok) {
        fetchWebhooks();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to delete webhook');
      }
    } catch (err) {
      setError('Network error deleting webhook');
    }
  };

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow mt-8">
      <div className="p-6 border-b">
        <h2 className="text-xl font-semibold mb-2">Webhooks</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Subscribe to real-time events. Payloads are delivered via POST and signed using HMAC-SHA256.
        </p>

        {error && <div className="mb-4 text-red-500 text-sm p-3 bg-red-50 rounded" aria-live="assertive">{error}</div>}

        <form onSubmit={handleCreate} className="flex gap-4 items-end">
          <div className="flex-1 max-w-md">
            <label htmlFor="webhookUrl" className="block text-sm font-medium mb-1">Endpoint URL</label>
            <Input 
              id="webhookUrl" 
              type="url"
              placeholder="https://your-server.com/webhook" 
              value={newUrl} 
              onChange={(e) => setNewUrl(e.target.value)} 
              required
            />
          </div>
          <Button type="submit" disabled={creating}>
            {creating ? 'Adding...' : 'Add Webhook'}
          </Button>
        </form>
      </div>

      <div className="p-0">
        {loading ? (
          <div className="p-6 text-center text-muted-foreground" aria-live="polite">Loading webhooks...</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>URL</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created At</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hooks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    No webhooks configured.
                  </TableCell>
                </TableRow>
              ) : (
                hooks.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="font-mono text-sm max-w-[200px] truncate" title={h.url}>{h.url}</TableCell>
                    <TableCell>{h.events.join(', ')}</TableCell>
                    <TableCell>
                      <span className={`text-xs px-2 py-1 rounded ${h.active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                        {h.active ? 'Active' : 'Inactive'}
                      </span>
                    </TableCell>
                    <TableCell>{new Date(h.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="destructive" size="sm" onClick={() => handleDelete(h.id)}>
                        Delete
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
