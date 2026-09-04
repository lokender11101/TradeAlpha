import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function getStats() {
  const result = await prisma.$queryRaw`
    SELECT count(*), state
    FROM pg_stat_activity
    GROUP BY state;
  `;
  console.log('pg_stat_activity counts:', result);

  const locks = await prisma.$queryRaw`
    SELECT count(*), mode
    FROM pg_locks
    GROUP BY mode;
  `;
  console.log('pg_locks counts:', locks);
  
  process.exit(0);
}
getStats().catch(e => { console.error(e); process.exit(1); });
