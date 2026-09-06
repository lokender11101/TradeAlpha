import { Request, Response } from 'express';
import { ApiKeysService } from '../services/api-keys.service';

const apiKeysService = new ApiKeysService();

export class ApiKeysController {
  static async createKey(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { name, scopes } = req.body;
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Valid name is required' });
      }

      const validScopes = ['orders:read', 'orders:write', 'portfolio:read'];
      const finalScopes = Array.isArray(scopes) ? scopes.filter(s => validScopes.includes(s)) : [];

      const { apiKey, plaintextSecret } = await apiKeysService.createKey(userId, name, finalScopes);

      return res.status(201).json({
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          keyPrefix: apiKey.keyPrefix,
          scopes: apiKey.scopes,
          createdAt: apiKey.createdAt,
        },
        plaintextSecret, // SHOWN ONLY ONCE
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to create API key' });
    }
  }

  static async listKeys(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const keys = await apiKeysService.listKeys(userId);
      return res.status(200).json(keys.map(k => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        scopes: k.scopes,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })));
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to list API keys' });
    }
  }

  static async revokeKey(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { id } = req.params;
      if (!id) return res.status(400).json({ error: 'Key ID required' });

      await apiKeysService.revokeKey(userId, id as string);
      return res.status(200).json({ success: true });
    } catch (error) {
      if ((error as Error).message === 'API key not found') {
        return res.status(404).json({ error: 'Key not found' });
      }
      return res.status(500).json({ error: 'Failed to revoke key' });
    }
  }
}
