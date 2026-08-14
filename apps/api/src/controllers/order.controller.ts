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

      const order = await orderService.placeOrder(dto);
      res.status(201).json(order);
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (
        error.message.includes('Insufficient') || 
        error.message.includes('Unauthorized') || 
        error.message.includes('require') ||
        error.message.includes('Quantity must be')
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
}
