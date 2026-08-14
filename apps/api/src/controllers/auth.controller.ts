import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

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

      const secret = process.env.JWT_SECRET || 'fallback-secret-for-tests';
      const expiresIn = process.env.JWT_EXPIRES_IN || '1h';
      const issuer = process.env.JWT_ISSUER || 'tradealpha';

      const token = jwt.sign(
        { email: user.email },
        secret,
        { subject: user.id, expiresIn: expiresIn as any, issuer }
      );

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000 // 1 hour
      });

      const csrfToken = crypto.randomUUID();
      res.cookie('csrf_token', csrfToken, {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000
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

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000 // 1 hour
      });
      
      // Provide a CSRF token for the frontend to use in subsequent state-changing requests
      const csrfToken = crypto.randomUUID();
      res.cookie('csrf_token', csrfToken, {
        httpOnly: false, // Must be readable by client JS to send in headers
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000 // 1 hour
      });

      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async logout(req: Request, res: Response): Promise<void> {
    res.clearCookie('token');
    res.clearCookie('csrf_token');
    res.status(200).json({ success: true });
  }

  static async getSession(req: Request, res: Response): Promise<void> {
    const token = req.cookies?.token;
    if (!token) {
      res.status(401).json({ error: 'Unauthorized: Missing token' });
      return;
    }

    const secret = process.env.JWT_SECRET || 'fallback-secret-for-tests';
    jwt.verify(token, secret, async (err: any, decoded: any) => {
      if (err) {
        res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
        return;
      }
      
      const user = await prisma.user.findUnique({ where: { id: decoded.sub as string } });
      if (!user) {
        res.status(401).json({ error: 'Unauthorized: User not found' });
        return;
      }

      res.status(200).json({
        id: user.id,
        email: user.email,
        portfolioId: (await prisma.portfolio.findFirst({ where: { userId: user.id } }))?.id
      });
    });
  }
}
