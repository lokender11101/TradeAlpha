import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

export class WebhooksController {
  static async createWebhook(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id || (req as any).user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { url, events } = req.body;
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        return res.status(400).json({ error: 'Valid URL is required' });
      }

      const validEvents = ['ORDER_ACCEPTED', 'ORDER_FILLED', 'ORDER_PARTIALLY_FILLED', 'ORDER_REJECTED', 'ORDER_CANCELLED', '*'];
      const finalEvents = Array.isArray(events) ? events.filter(e => validEvents.includes(e)) : [];
      if (finalEvents.length === 0) finalEvents.push('*');

      const secret = crypto.randomBytes(32).toString('hex');

      const webhook = await prisma.webhookSubscription.create({
        data: {
          userId,
          url,
          secret,
          events: finalEvents
        }
      });

      return res.status(201).json(webhook);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to create webhook' });
    }
  }

  static async listWebhooks(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id || (req as any).user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const hooks = await prisma.webhookSubscription.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' }
      });
      return res.status(200).json(hooks);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to list webhooks' });
    }
  }

  static async deleteWebhook(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id || (req as any).user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { id } = req.params;
      const hook = await prisma.webhookSubscription.findUnique({ where: { id: id as string } });
      if (!hook || hook.userId !== userId) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      await prisma.webhookSubscription.delete({ where: { id: id as string } });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to delete webhook' });
    }
  }
}
