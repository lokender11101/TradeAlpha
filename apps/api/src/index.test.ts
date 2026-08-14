import request from 'supertest';
import { app } from './main.api';

describe('API Core', () => {
  it('should return 200 OK for /health', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('should return 404 for unknown route', async () => {
    const res = await request(app).get('/unknown-route');
    expect(res.statusCode).toEqual(404);
    expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
  });
});
