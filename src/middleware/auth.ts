import { Request, Response, NextFunction } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

// Service key for internal worker → ai-generator calls (no user token needed)
const SERVICE_KEY = process.env.AI_GENERATOR_SERVICE_KEY ?? '';

// Created once at startup; null when env vars are absent (local dev without Cognito)
const verifier = process.env.COGNITO_USER_POOL_ID
  ? CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse: 'access',
      clientId: null,
    })
  : null;

if (!verifier) {
  console.warn('[ai-generator] COGNITO_USER_POOL_ID not set — JWT auth disabled (dev mode only)');
}

/**
 * Verifies the caller is either:
 *   (a) the worker — presenting a matching x-service-key header, or
 *   (b) a human user — presenting a valid Cognito access token.
 *
 * When COGNITO_USER_POOL_ID is absent (dev without Cognito), passes through.
 * When AI_GENERATOR_SERVICE_KEY is absent, the service-key bypass is disabled.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Internal service-to-service call: worker passes x-service-key
  if (SERVICE_KEY && req.headers['x-service-key'] === SERVICE_KEY) {
    req.user = { id: 'worker', email: 'worker@internal', role: 'service' };
    return next();
  }

  // No Cognito verifier in dev — pass through
  if (!verifier) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized', code: 'MISSING_AUTH_HEADER', ref: req.requestId });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: 'Unauthorized', code: 'MISSING_TOKEN', ref: req.requestId });
    return;
  }

  try {
    const payload = await (verifier as any).verify(token, { clientId: null });
    const groups: string[] = (payload['cognito:groups'] as string[]) || [];
    req.user = {
      id: payload.sub as string,
      email: (payload.email as string) || (payload.username as string) || '',
      role: groups.includes('admin') ? 'admin' : 'user',
    };
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized', code: 'INVALID_TOKEN', ref: req.requestId });
  }
}
