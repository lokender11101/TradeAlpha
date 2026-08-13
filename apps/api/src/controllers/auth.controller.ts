import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();

export class AuthController {
  static async register(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required' });
        return;
      }

      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        res.status(400).json({ error: 'User already exists' });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: { email, passwordHash }
      });

      // Automatically create a default portfolio for new users
      await prisma.portfolio.create({
        data: { userId: user.id }
      });

      res.status(201).json({ id: user.id, email: user.email });
    } catch (error) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required' });
        return;
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const validPassword = await bcrypt.compare(password, user.passwordHash);
      if (!validPassword) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const secret = process.env.JWT_SECRET || 'fallback-secret-for-tests';
      const expiresIn = process.env.JWT_EXPIRES_IN || '1h';
      const issuer = process.env.JWT_ISSUER || 'tradealpha';

      const token = jwt.sign(
        { email: user.email },
        secret,
        { subject: user.id, expiresIn: expiresIn as any, issuer }
      );

      res.status(200).json({ token });
    } catch (error) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
}
