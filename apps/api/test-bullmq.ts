import { Queue } from 'bullmq';

async function run() {
  const q = new Queue('execution', { connection: { host: 'localhost', port: 6379 } });
  const counts = await q.getJobCounts();
  console.log('Counts:', counts);
  process.exit(0);
}
run();
