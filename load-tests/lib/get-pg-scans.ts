import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function getStats() {
  const result = await prisma.$queryRaw`
    SELECT relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch
    FROM pg_stat_user_tables
    ORDER BY seq_scan DESC
    LIMIT 10;
  `;
  console.log('pg_stat_user_tables:', result);
  process.exit(0);
}
getStats().catch(e => { console.error(e); process.exit(1); });
