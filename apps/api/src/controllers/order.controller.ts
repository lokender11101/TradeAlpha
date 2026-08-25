import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OrderService, PlaceOrderDto } from '../services/order.service';

import { AuthenticatedRequest } from '../middlewares/auth.middleware';

const prisma = new PrismaClient();
const orderService = new OrderService(prisma);

export class OrderController {
  static async placeOrder(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const dto: PlaceOrderDto = req.body;
      
      // Override any client-provided userId with the verified JWT identity
      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      dto.userId = req.user.id;
      
      if (!dto.portfolioId) {
        const portfolio = await prisma.portfolio.findFirst({ where: { userId: dto.userId } });
        if (portfolio) {
          dto.portfolioId = portfolio.id;
        } else {
          res.status(400).json({ error: 'No portfolio found for user' });
          return;
        }
      }

      const order = await orderService.placeOrder(dto);
      res.status(201).json(order);
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (
        error.message.includes('Insufficient') || 
        error.message.includes('Unauthorized') || 
        error.message.includes('require') ||
        error.message.includes('Quantity must be') ||
        error.message.includes('Market is closed')
        ) {
          res.status(400).json({ error: error.message });
        } else {
          console.error('placeOrder 500 error:', error);
          res.status(500).json({ error: 'Internal Server Error' });
        }
      } else {
        console.error('placeOrder unknown error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  }
  static async getOrders(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const skip = (page - 1) * limit;

      const where: any = { userId };

      if (req.query.status) {
        let statuses = req.query.status;
        if (typeof statuses === 'string' && statuses.includes(',')) {
          statuses = statuses.split(',');
        }
        where.status = { in: Array.isArray(statuses) ? statuses : [statuses] };
      }
      if (req.query.symbol) where.symbol = req.query.symbol;
      if (req.query.side) where.side = req.query.side;
      if (req.query.type) where.type = req.query.type;
      
      if (req.query.from || req.query.to) {
        where.createdAt = {};
        if (req.query.from) where.createdAt.gte = new Date(req.query.from as string);
        if (req.query.to) where.createdAt.lte = new Date(req.query.to as string);
      }

      const [totalRecords, orders] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: limit,
        }),
      ]);

      const totalPages = Math.ceil(totalRecords / limit);

      res.status(200).json({
        data: orders,
        meta: {
          totalRecords,
          totalPages,
          currentPage: page,
          pageSize: limit,
        }
      });
    } catch (error) {
      console.error('getOrders 500 error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async cancelOrder(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const orderId = req.params.id as string;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Authorization check
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }

      if (order.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const cancelledOrder = await orderService.cancelOrder(orderId);
      res.status(200).json(cancelledOrder);
    } catch (error: any) {
      if (error.message && (error.message.includes('Invalid state transition') || error.message.includes('No Order found'))) {
        res.status(400).json({ error: error.message });
      } else {
        console.error('cancelOrder 500 error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  }
}
