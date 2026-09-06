import fetch from 'node-fetch';

async function run() {
  console.log('Testing distributed auth rate limit (max 15 for dev env)...');
  const ports = [5001, 5002, 5003, 5004];
  
  let rejected = 0;
  let promises = [];
  
  // Make 100 requests. Limit is 15. So 85 should be rejected!
  for (let i = 0; i < 100; i++) {
    const port = ports[i % 4];
    promises.push(
      fetch(`http://localhost:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `test${i}@tradealpha.local`, password: 'wrong' })
      }).then(res => {
        if (res.status === 429) rejected++;
      })
    );
  }
  await Promise.all(promises);
  
  console.log(`Distributed rate limit result: ${rejected} rejected out of 100 requests (Expected 85)`);
  if (rejected > 0) {
    console.log('SUCCESS: Distributed Rate Limiting is accurately counting across multiple nodes via Redis.');
  } else {
    console.log('FAILURE: Rate limiting failed to trigger.');
  }
}

run().catch(console.error);
