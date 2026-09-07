'use client';

import { useAuth } from '@/lib/auth-context';
import { ApiKeys } from '@/components/developer/api-keys';
import { Webhooks } from '@/components/developer/webhooks';

export default function DeveloperPage() {
  const { user, loading } = useAuth();

  if (loading) return <div className="p-8" aria-live="polite">Loading...</div>;
  if (!user) return null;

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold mb-2">Developer Settings</h1>
        <p className="text-muted-foreground">Manage your API keys and webhook integrations.</p>
      </div>
      
      <ApiKeys />
      <Webhooks />
    </div>
  );
}
