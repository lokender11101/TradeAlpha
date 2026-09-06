import { PrismaClient } from '@prisma/client';
import { ApiKeysService } from './api-keys.service';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const apiKeysService = new ApiKeysService();

describe('ApiKeysService', () => {
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `test-api-keys-${Date.now()}@example.com`,
        passwordHash: 'hash',
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('should create an API key securely', async () => {
    const { apiKey, plaintextSecret } = await apiKeysService.createKey(userId, 'Test Key', ['orders:write']);
    
    expect(apiKey.name).toBe('Test Key');
    expect(apiKey.scopes).toEqual(['orders:write']);
    expect(apiKey.userId).toBe(userId);
    expect(apiKey.keyPrefix).toBeDefined();
    expect(apiKey.revokedAt).toBeNull();
    
    // Ensure plaintext secret starts with prefix
    expect(plaintextSecret.startsWith(apiKey.keyPrefix + '.')).toBe(true);

    // Verify hash matches plaintext
    const isValid = await bcrypt.compare(plaintextSecret, apiKey.secretHash);
    expect(isValid).toBe(true);
  });

  it('should list only active keys', async () => {
    const { apiKey: key1 } = await apiKeysService.createKey(userId, 'Key 1', []);
    const { apiKey: key2 } = await apiKeysService.createKey(userId, 'Key 2', []);

    await apiKeysService.revokeKey(userId, key1.id);

    const keys = await apiKeysService.listKeys(userId);
    expect(keys.find(k => k.id === key1.id)).toBeUndefined();
    expect(keys.find(k => k.id === key2.id)).toBeDefined();
  });

  it('should revoke an API key', async () => {
    const { apiKey } = await apiKeysService.createKey(userId, 'To Revoke', []);
    
    const revoked = await apiKeysService.revokeKey(userId, apiKey.id);
    expect(revoked.revokedAt).not.toBeNull();
  });

  it('should reject revoking a key owned by another user', async () => {
    const otherUser = await prisma.user.create({
      data: { email: `other-${Date.now()}@example.com`, passwordHash: 'hash' }
    });
    const { apiKey } = await apiKeysService.createKey(otherUser.id, 'Other Key', []);

    await expect(apiKeysService.revokeKey(userId, apiKey.id)).rejects.toThrow('API key not found');

    await prisma.apiKey.deleteMany({ where: { userId: otherUser.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
  });
});
