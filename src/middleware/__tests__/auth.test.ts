import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Response } from 'express';

type AuthModule = typeof import('../auth');
type VerifyMock = jest.MockedFunction<
  (token: string, options: { clientId: null }) => Promise<unknown>
>;
type VerifierMock = { verify: VerifyMock };

const ORIGINAL_SERVICE_KEY = process.env.AI_GENERATOR_SERVICE_KEY;
const ORIGINAL_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

function setEnv(env: { serviceKey?: string; userPoolId?: string }) {
  if (env.serviceKey === undefined) {
    delete process.env.AI_GENERATOR_SERVICE_KEY;
  } else {
    process.env.AI_GENERATOR_SERVICE_KEY = env.serviceKey;
  }

  if (env.userPoolId === undefined) {
    delete process.env.COGNITO_USER_POOL_ID;
  } else {
    process.env.COGNITO_USER_POOL_ID = env.userPoolId;
  }
}

function loadAuthModule(
  env: { serviceKey?: string; userPoolId?: string },
  verifier: VerifierMock = {
    verify: jest.fn<(token: string, options: { clientId: null }) => Promise<unknown>>(),
  },
): AuthModule {
  jest.resetModules();
  setEnv(env);
  jest.doMock('aws-jwt-verify', () => ({
    CognitoJwtVerifier: {
      create: jest.fn(() => verifier),
    },
  }));

  return require('../auth') as AuthModule;
}

function buildHarness(headers: Record<string, string | undefined> = {}) {
  const req = { headers, requestId: 'req-123' } as any;
  const status = jest.fn().mockReturnThis();
  const json = jest.fn();
  const res = { status, json } as unknown as Response;
  const nextMock = jest.fn();
  const next = nextMock as unknown as NextFunction;

  return { req, res, status, json, next, nextMock };
}

describe('requireAuth', () => {
  afterEach(() => {
    if (ORIGINAL_SERVICE_KEY === undefined) {
      delete process.env.AI_GENERATOR_SERVICE_KEY;
    } else {
      process.env.AI_GENERATOR_SERVICE_KEY = ORIGINAL_SERVICE_KEY;
    }

    if (ORIGINAL_USER_POOL_ID === undefined) {
      delete process.env.COGNITO_USER_POOL_ID;
    } else {
      process.env.COGNITO_USER_POOL_ID = ORIGINAL_USER_POOL_ID;
    }

    jest.restoreAllMocks();
    jest.resetModules();
    jest.dontMock('aws-jwt-verify');
  });

  it('accepts a matching service key as the internal worker identity', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { requireAuth } = loadAuthModule({ serviceKey: 'service-secret' });
    const { req, res, next, nextMock, status, json } = buildHarness({
      'x-service-key': 'service-secret',
    });

    await requireAuth(req, res, next);

    expect(req.user).toEqual({
      id: 'worker',
      email: 'worker@internal',
      role: 'service',
    });
    expect(nextMock).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('passes through in dev mode when Cognito is not configured', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { requireAuth } = loadAuthModule({});
    const { req, res, next, nextMock, status } = buildHarness();

    await requireAuth(req, res, next);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('JWT auth disabled (dev mode only)'));
    expect(req.user).toBeUndefined();
    expect(nextMock).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects requests without a bearer token when Cognito is configured', async () => {
    const verifier: VerifierMock = {
      verify: jest.fn<(token: string, options: { clientId: null }) => Promise<unknown>>(),
    };
    const { requireAuth } = loadAuthModule({ userPoolId: 'pool-123' }, verifier);
    const { req, res, next, nextMock, status, json } = buildHarness();

    await requireAuth(req, res, next);

    expect(nextMock).not.toHaveBeenCalled();
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      code: 'MISSING_AUTH_HEADER',
      ref: 'req-123',
    });
  });

  it('attaches a verified Cognito user and promotes admin group membership', async () => {
    const verifier: VerifierMock = {
      verify: jest.fn<(token: string, options: { clientId: null }) => Promise<unknown>>().mockResolvedValue({
        sub: 'user-123',
        email: 'user@example.com',
        'cognito:groups': ['admin'],
      }),
    };
    const { requireAuth } = loadAuthModule({ userPoolId: 'pool-123' }, verifier);
    const { req, res, next, nextMock, status } = buildHarness({
      authorization: 'Bearer valid-token',
    });

    await requireAuth(req, res, next);

    expect(verifier.verify).toHaveBeenCalledWith('valid-token', { clientId: null });
    expect(req.user).toEqual({
      id: 'user-123',
      email: 'user@example.com',
      role: 'admin',
    });
    expect(nextMock).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects invalid Cognito tokens', async () => {
    const verifier: VerifierMock = {
      verify: jest.fn<(token: string, options: { clientId: null }) => Promise<unknown>>().mockRejectedValue(new Error('bad token')),
    };
    const { requireAuth } = loadAuthModule({ userPoolId: 'pool-123' }, verifier);
    const { req, res, next, nextMock, status, json } = buildHarness({
      authorization: 'Bearer expired-token',
    });

    await requireAuth(req, res, next);

    expect(nextMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      code: 'INVALID_TOKEN',
      ref: 'req-123',
    });
  });
});
