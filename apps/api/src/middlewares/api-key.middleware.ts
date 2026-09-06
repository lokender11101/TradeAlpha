import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import pino from 'pino';
import Redis from 'ioredis';
const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const logger = pino();
const prisma = new PrismaClient();
const MASTER_SECRET = process.env.API_KEY_MASTER_SECRET || 'default-master-secret-for-api-keys';

export const authenticateApiKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] as string;
    const timestampHeader = req.headers['x-timestamp'] as string;
    const signatureHeader = req.headers['x-signature'] as string;

    if (!apiKeyHeader || !timestampHeader || !signatureHeader) {
      res.status(401).json({ error: 'Unauthorized: Missing API Key headers' });
      return;
    }

    // 1. Timestamp validation (5 minute window)
    const requestTime = parseInt(timestampHeader, 10);
    if (isNaN(requestTime)) {
      res.status(401).json({ error: 'Unauthorized: Invalid timestamp' });
      return;
    }
    const now = Date.now();
    if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
      res.status(401).json({ error: 'Unauthorized: Timestamp expired' });
      return;
    }

    // 2. Lookup API Key by prefix
    // The X-API-Key should be the public keyPrefix (e.g. TA_xxxx)
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyPrefix: apiKeyHeader }
    });

    if (!apiKey) {
      res.status(401).json({ error: 'Unauthorized: Invalid API key' });
      return;
    }
    if (apiKey.revokedAt) {
      res.status(401).json({ error: 'Unauthorized: API key revoked' });
      return;
    }

    // 3. Replay Protection using Redis
    // We use the signature itself as the nonce. If we've seen this signature recently, reject it.
    const replayKey = `api:replay:${signatureHeader}`;
    const isNew = await redisClient.set(replayKey, '1', 'PX', 5 * 60 * 1000, 'NX');
    if (!isNew) {
      res.status(401).json({ error: 'Unauthorized: Replay attack detected' });
      return;
    }

    // 4. Verify HMAC Signature
    // Derive the HMAC secret for this key
    const hmacSecret = crypto.createHmac('sha256', MASTER_SECRET).update(apiKey.keyPrefix).digest('base64');

    // Canonical string: METHOD + \n + PATH + \n + TIMESTAMP + \n + BODY
    const bodyStr = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : '';
    const canonicalString = `${req.method}\n${req.originalUrl}\n${timestampHeader}\n${bodyStr}`;

    const expectedSignature = crypto.createHmac('sha256', hmacSecret)
      .update(canonicalString)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature);
    const actualBuffer = Buffer.from(signatureHeader);

    if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
      res.status(401).json({ error: 'Unauthorized: Invalid signature' });
      return;
    }

    // 5. Scope Checking
    const requiredScope = getRequiredScope(req);
    if (requiredScope && !apiKey.scopes.includes(requiredScope)) {
      res.status(403).json({ error: 'Forbidden: Insufficient scope' });
      return;
    }

    // Update last used asynchronously
    prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(e => logger.error(e));

    // Inject user context
    (req as any).user = { id: apiKey.userId };
    (req as any).apiKeyId = apiKey.id;

    next();
  } catch (error) {
    logger.error(error, 'API Key Auth Error');
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

function getRequiredScope(req: Request): string | null {
  if (req.path.startsWith('/api/public/orders')) {
    return req.method === 'GET' ? 'orders:read' : 'orders:write';
  }
  if (req.path.startsWith('/api/public/portfolio')) {
    return 'portfolio:read';
  }
  return null;
}
