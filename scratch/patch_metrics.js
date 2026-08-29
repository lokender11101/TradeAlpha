const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../apps/web/src/components/dashboard/portfolio-metrics.tsx');
let code = fs.readFileSync(filePath, 'utf8');

const targetReturn = `  return (
    <div className="grid gap-4 md:grid-cols-4">
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Net Asset Value (NAV)</h3>
        <p className="text-3xl font-bold">\${totalNav.toFixed(2)}</p>
        {metrics.isStale && <p className="text-xs text-yellow-500 mt-1">Pricing data may be stale</p>}
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Total Cash</h3>
        <p className="text-3xl font-bold">\${totalCash.toFixed(2)}</p>
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Available Cash</h3>
        <p className="text-3xl font-bold">\${availableCash.toFixed(2)}</p>
      </div>
      <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
        <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Unrealized P&L</h3>
        <p className={\`text-3xl font-bold \${unrealizedPnl > 0 ? 'text-green-500' : unrealizedPnl < 0 ? 'text-red-500' : ''}\`}>
          {unrealizedPnl < 0 ? '-' : ''}\${Math.abs(unrealizedPnl).toFixed(2)}
        </p>
      </div>
    </div>
  );`;

const newReturn = `  return (
    <div className="grid gap-4 md:grid-cols-4">
      {metrics.isMarginEnabled ? (
        <>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6 flex flex-col justify-between">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-semibold leading-none tracking-tight text-muted-foreground">Equity</h3>
              <span className={\`text-xs px-2 py-1 rounded font-bold \${metrics.marginStatus === 'MARGIN_CALL' ? 'bg-red-200 text-red-900' : 'bg-green-100 text-green-800'}\`}>
                {metrics.marginStatus}
              </span>
            </div>
            <p className="text-3xl font-bold">\${totalNav.toFixed(2)}</p>
            {metrics.isStale && <p className="text-xs text-yellow-500 mt-1">Pricing data may be stale</p>}
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Free Margin</h3>
            <p className="text-3xl font-bold">\${parseFloat(metrics.freeMargin || '0').toFixed(2)}</p>
            <p className="text-xs text-muted-foreground mt-2">Buying Power: \${parseFloat(metrics.buyingPower || '0').toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Used Margin</h3>
            <p className="text-3xl font-bold">\${parseFloat(metrics.usedMargin || '0').toFixed(2)}</p>
            <p className="text-xs text-muted-foreground mt-2">Locked: \${parseFloat(metrics.lockedMargin || '0').toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Margin Level</h3>
            <p className={\`text-3xl font-bold \${metrics.marginStatus === 'MARGIN_CALL' ? 'text-red-500' : ''}\`}>
              {metrics.marginLevel ? \`\${parseFloat(metrics.marginLevel).toFixed(2)}%\` : 'N/A'}
            </p>
            <p className="text-xs text-muted-foreground mt-2">Maint Req: \${parseFloat(metrics.maintenanceMargin || '0').toFixed(2)}</p>
          </div>
        </>
      ) : (
        <>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Net Asset Value (NAV)</h3>
            <p className="text-3xl font-bold">\${totalNav.toFixed(2)}</p>
            {metrics.isStale && <p className="text-xs text-yellow-500 mt-1">Pricing data may be stale</p>}
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Total Cash</h3>
            <p className="text-3xl font-bold">\${totalCash.toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Available Cash</h3>
            <p className="text-3xl font-bold">\${availableCash.toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
            <h3 className="font-semibold leading-none tracking-tight text-muted-foreground mb-2">Unrealized P&L</h3>
            <p className={\`text-3xl font-bold \${unrealizedPnl > 0 ? 'text-green-500' : unrealizedPnl < 0 ? 'text-red-500' : ''}\`}>
              {unrealizedPnl < 0 ? '-' : ''}\${Math.abs(unrealizedPnl).toFixed(2)}
            </p>
          </div>
        </>
      )}
    </div>
  );`;

code = code.replace(targetReturn, newReturn);
fs.writeFileSync(filePath, code);
