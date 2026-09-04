import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  stages: [
    { duration: '5s', target: 100 },
    { duration: '15s', target: 100 },
    { duration: '5s', target: 0 },
  ],
};

export function setup() {
  const users = [];
  for (let i = 1; i <= 20; i++) {
    const loginRes = http.post('http://host.docker.internal:4000/api/auth/login', JSON.stringify({
      email: `playwright${i}@tradealpha.local`,
      password: 'Playwright123!'
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
    
    // In k6, cookies are automatically managed in the default cookie jar per VU,
    // but we can extract them to pass around manually.
    let csrf = '';
    let token = '';
    
    const cookies = loginRes.cookies;
    if (cookies && cookies.csrf_token) csrf = cookies.csrf_token[0].value;
    if (cookies && cookies.token) token = cookies.token[0].value;
    
    if (loginRes.status !== 200) {
      console.log(`Failed to login user ${i}, status: ${loginRes.status}`);
    }

    users.push({ csrfToken: csrf, token: token });
  }
  return users;
}

export default function (users) {
  // Pick random user
  const user = users[Math.floor(Math.random() * users.length)];

  const payload = JSON.stringify({
    symbol: 'AAPL',
    side: 'BUY',
    type: 'MARKET',
    requestedQuantity: '1',
    currentMarketPrice: '150.00',
    idempotencyKey: uuidv4(),
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': user.csrfToken,
      'Authorization': `Bearer ${user.token}`,
      'Cookie': `token=${user.token}; csrf_token=${user.csrfToken}`
    },
  };

  const res = http.post('http://host.docker.internal:4000/api/orders', payload, params);
  
  check(res, { 'status is 201': (r) => r.status === 201 });
}
