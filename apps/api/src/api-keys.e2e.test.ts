import 'dotenv/config';
import request from 'supertest';
import { app } from './main.api';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-tests';

describe('ApiKeysController E2E', () => {
  let userId: string;
  let authToken: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `e2e-api-keys-${Date.now()}@example.com`,
        passwordHash: 'hash',
      },
    });
    userId = user.id;
    authToken = jwt.sign({ sub: userId, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  let createdKeyId: string;

  it('should create an API key', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .set('x-csrf-token', 'testcsrf')
      .set('Cookie', [`csrf_token=testcsrf`])
      .send({ name: 'Trading Bot', scopes: ['orders:write', 'portfolio:read'] });

    expect(res.status).toBe(201);
    expect(res.body.apiKey).toBeDefined();
    expect(res.body.apiKey.name).toBe('Trading Bot');
    expect(res.body.plaintextSecret).toBeDefined();
    createdKeyId = res.body.apiKey.id;
  });

  it('should list API keys', async () => {
    const res = await request(app)
      .get('/api/keys')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].name).toBe('Trading Bot');
  });

  it('should revoke an API key', async () => {
    const res = await request(app)
      .delete(`/api/keys/${createdKeyId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('x-csrf-token', 'testcsrf')
      .set('Cookie', [`csrf_token=testcsrf`]);

    expect(res.status).toBe(200);
    
    // Validate it's gone from list
    const res2 = await request(app)
      .get('/api/keys')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res2.body.length).toBe(0);
  });
});
