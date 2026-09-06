import fetch from 'node-fetch';

async function run() {
  console.log('Testing auth rate limiting...');
  for (let i = 0; i < 20; i++) {
    const res = await fetch('http://localhost:4000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'playwright1@tradealpha.local', password: 'wrong' })
    });
    if (res.status === 429) {
      console.log(`Auth rate limit triggered at attempt ${i + 1} with 429`);
      break;
    }
  }

  // We should also test order rate limiting, but we gave it a very high limit for E2E tests (10000).
  console.log('Test complete!');
}

run().catch(console.error);
