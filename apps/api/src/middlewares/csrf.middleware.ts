import { Request, Response, NextFunction } from 'express';

export const requireCsrfToken = (req: Request, res: Response, next: NextFunction): void => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const csrfCookie = req.cookies?.csrf_token;
  const csrfHeader = req.headers['x-csrf-token'];
  if (!csrfCookie) {
    res.status(403).json({ error: 'Forbidden: Missing CSRF cookie' });
    return;
  }
  if (!csrfHeader) {
    res.status(403).json({ error: 'Forbidden: Missing CSRF token header' });
    return;
  }
  if (csrfCookie !== csrfHeader) {
    res.status(403).json({ error: 'Forbidden: CSRF token mismatch' });
    return;
  }
  next();
};
