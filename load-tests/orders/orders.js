import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  stages: [
    { duration: '10s', target: 20 },
    { duration: '20s', target: 20 },
    { duration: '10s', target: 0 },
  ],
};

export function setup() {
  const loginRes = http.post('http://host.docker.internal:4000/api/auth/login', JSON.stringify({
    email: 'playwright@tradealpha.local',
    password: 'Playwright123!'
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${loginRes.body}`);
  }
  
  const jar = http.cookieJar();
  const cookies = jar.cookiesForURL('http://host.docker.internal:4000/');
  return { 
    csrfToken: cookies.csrf_token ? cookies.csrf_token[0] : '',
    token: cookies.token ? cookies.token[0] : ''
  };
}

export default function (data) {
  const payload = JSON.stringify({
    symbol: 'AAPL',
    side: 'BUY',
    type: 'MARKET',
    requestedQuantity: '1',
    idempotencyKey: uuidv4(),
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': data.csrfToken,
      'Authorization': `Bearer ${data.token}`,
      'Cookie': `token=${data.token}; csrf_token=${data.csrfToken}`
    },
  };

  const res = http.post('http://host.docker.internal:4000/api/orders', payload, params);
  
  check(res, {
    'status is 201': (r) => r.status === 201,
  });

  sleep(0.1);
}
