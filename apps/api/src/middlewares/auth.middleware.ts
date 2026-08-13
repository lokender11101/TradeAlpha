import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pino from 'pino';

const logger = pino();

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
  };
}

export const authenticateJWT = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];

    if (!token) {
      res.status(401).json({ error: 'Unauthorized: Malformed token' });
      return;
    }

    const secret = process.env.JWT_SECRET || 'fallback-secret-for-tests';

    jwt.verify(token, secret, (err: any, decoded: any) => {
      if (err) {
        logger.warn({ err }, 'JWT Verification Failed');
        if (err.name === 'TokenExpiredError') {
          res.status(401).json({ error: 'Unauthorized: Token expired' });
        } else {
          res.status(401).json({ error: 'Unauthorized: Invalid signature' });
        }
        return;
      }

      req.user = { id: decoded.sub as string };
      next();
    });
  } else {
    res.status(401).json({ error: 'Unauthorized: Missing token' });
  }
};
