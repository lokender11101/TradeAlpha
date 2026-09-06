import 'dotenv/config';
import request from 'supertest';
import { app } from './main.api';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-tests';

describe('WebhooksController E2E', () => {
  let userId: string;
  let authToken: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `e2e-webhooks-${Date.now()}@example.com`,
        passwordHash: 'hash',
      },
    });
    userId = user.id;
    authToken = jwt.sign({ sub: userId, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    await prisma.webhookSubscription.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  let createdHookId: string;

  it('should create a webhook subscription', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${authToken}`)
      .set('x-csrf-token', 'testcsrf')
      .set('Cookie', [`csrf_token=testcsrf`])
      .send({ url: 'https://example.com/webhook', events: ['ORDER_ACCEPTED'] });

    expect(res.status).toBe(201);
    expect(res.body.url).toBe('https://example.com/webhook');
    expect(res.body.events).toContain('ORDER_ACCEPTED');
    expect(res.body.secret).toBeDefined();
    createdHookId = res.body.id;
  });

  it('should list webhook subscriptions', async () => {
    const res = await request(app)
      .get('/api/webhooks')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].url).toBe('https://example.com/webhook');
  });

  it('should delete a webhook subscription', async () => {
    const res = await request(app)
      .delete(`/api/webhooks/${createdHookId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('x-csrf-token', 'testcsrf')
      .set('Cookie', [`csrf_token=testcsrf`]);

    expect(res.status).toBe(200);
    
    // Validate it's gone from list
    const res2 = await request(app)
      .get('/api/webhooks')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res2.body.length).toBe(0);
  });
});
