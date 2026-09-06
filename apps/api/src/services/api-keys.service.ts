import { PrismaClient, ApiKey } from '@prisma/client';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

export class ApiKeysService {
  async createKey(userId: string, name: string, scopes: string[]): Promise<{ apiKey: ApiKey; plaintextSecret: string }> {
    const rawSecret = crypto.randomBytes(32).toString('base64');
    const keyPrefix = 'TA_' + crypto.randomBytes(8).toString('hex');
    const plaintextSecret = `${keyPrefix}.${rawSecret}`;

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
