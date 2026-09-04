import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 1,
  duration: '1s',
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
    quantity: '1',
    idempotencyKey: Math.random().toString(),
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
  
  if (res.status !== 201) {
    console.log(res.body);
  }
  
  check(res, {
    'status is 201': (r) => r.status === 201,
  });
}
