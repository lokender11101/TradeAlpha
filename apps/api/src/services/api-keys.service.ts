import { PrismaClient, ApiKey } from '@prisma/client';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();
// A master secret used to derive HMAC keys statelessly
const MASTER_SECRET = process.env.API_KEY_MASTER_SECRET || 'default-master-secret-for-api-keys';

export class ApiKeysService {
  async createKey(userId: string, name: string, scopes: string[]): Promise<{ apiKey: ApiKey; plaintextSecret: string }> {
    // Generate a unique prefix
    const keyPrefix = 'TA_' + crypto.randomBytes(8).toString('hex');
    
    // Derive the HMAC secret using the master secret and the prefix
    const hmacSecret = crypto.createHmac('sha256', MASTER_SECRET).update(keyPrefix).digest('base64');
    
    // The plaintext secret shown to the user is Prefix + "." + HMAC Secret
    const plaintextSecret = `${keyPrefix}.${hmacSecret}`;

    // Store a one-way hash in the database to satisfy the requirement
    const secretHash = await bcrypt.hash(plaintextSecret, 10);

    const apiKey = await prisma.apiKey.create({
      data: {
        userId,
        keyPrefix,
        secretHash,
        name,
        scopes,
      },
    });

    return { apiKey, plaintextSecret };
  }

  async listKeys(userId: string): Promise<ApiKey[]> {
    return prisma.apiKey.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' }
    });
  }

  async revokeKey(userId: string, keyId: string): Promise<ApiKey> {
    const key = await prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!key || key.userId !== userId) {
      throw new Error('API key not found');
    }
    
    if (key.revokedAt) {
      return key; // Already revoked
    }

    return prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
  }
}
