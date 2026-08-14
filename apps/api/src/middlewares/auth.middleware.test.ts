import { authenticateJWT, AuthenticatedRequest } from './auth.middleware';
import { Response } from 'express';
import jwt from 'jsonwebtoken';

describe('Auth Middleware', () => {
  let mockReq: Partial<AuthenticatedRequest>;
  let mockRes: Partial<Response>;
  let nextFunction: jest.Mock;

  beforeEach(() => {
    mockReq = {
      headers: {},
      cookies: {}
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    nextFunction = jest.fn();
  });

  it('should return 401 if no authorization header is present', () => {
    authenticateJWT(mockReq as AuthenticatedRequest, mockRes as Response, nextFunction);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Unauthorized: Missing token' });
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('should return 401 if token is malformed', () => {
    mockReq.headers = { authorization: 'Bearer ' };
    
    authenticateJWT(mockReq as AuthenticatedRequest, mockRes as Response, nextFunction);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Unauthorized: Malformed token' });
  });

  it('should return 401 if token signature is invalid', () => {
    const invalidToken = jwt.sign({ sub: 'user-123' }, 'wrong-secret');
    mockReq.headers = { authorization: `Bearer ${invalidToken}` };

    authenticateJWT(mockReq as AuthenticatedRequest, mockRes as Response, nextFunction);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Unauthorized: Invalid signature' });
  });

  it('should return 401 if token is expired', () => {
    const expiredToken = jwt.sign({ sub: 'user-123' }, 'fallback-secret-for-tests', { expiresIn: '-1h' });
    mockReq.headers = { authorization: `Bearer ${expiredToken}` };

    authenticateJWT(mockReq as AuthenticatedRequest, mockRes as Response, nextFunction);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Unauthorized: Token expired' });
  });

  it('should call next and set req.user if token is valid', () => {
    const validToken = jwt.sign({}, 'fallback-secret-for-tests', { subject: 'user-123' });
    mockReq.headers = { authorization: `Bearer ${validToken}` };

    authenticateJWT(mockReq as AuthenticatedRequest, mockRes as Response, nextFunction);

    expect(mockReq.user).toBeDefined();
    expect(mockReq.user?.id).toBe('user-123');
    expect(nextFunction).toHaveBeenCalled();
  });
});
