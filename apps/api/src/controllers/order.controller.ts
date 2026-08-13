import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OrderService, PlaceOrderDto } from '../services/order.service';

const prisma = new PrismaClient();
const orderService = new OrderService(prisma);

export class OrderController {
  static async placeOrder(req: Request, res: Response): Promise<void> {
    try {
      const dto: PlaceOrderDto = req.body;
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
          res.status(500).json({ error: 'Internal Server Error' });
        }
      } else {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  }
}
