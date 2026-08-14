'use client';

import { useAuth } from '@/lib/auth-context';
import { PortfolioMetrics } from '@/components/dashboard/portfolio-metrics';
import { PositionsTable } from '@/components/dashboard/positions-table';
import { OpenOrders } from '@/components/dashboard/open-orders';

export default function DashboardPage() {
  const { user, loading } = useAuth();

  if (loading) return <div className="p-8">Loading...</div>;
  if (!user) return null;

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Portfolio Dashboard</h1>
        <p className="text-muted-foreground">Welcome back, {user.email}</p>
      </div>
      
      <PortfolioMetrics />
      
      <div className="grid gap-8">
        <PositionsTable />
        <OpenOrders />
      </div>
    </div>
  );
}
