import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

import { requestIdMiddleware } from '../request-id';

function buildMiddlewareHarness(headers: Request['headers'] = {}) {
  const req = { headers } as Request;
  const setHeader = jest.fn();
  const res = { setHeader } as unknown as Response;
  const nextMock = jest.fn();
  const next = nextMock as unknown as NextFunction;

  return { req, res, setHeader, next, nextMock };
}

describe('requestIdMiddleware', () => {
  it('preserves an incoming x-request-id on the request and response', () => {
    const { req, res, setHeader, next, nextMock } = buildMiddlewareHarness({
      'x-request-id': 'incoming-request-id',
    });

    requestIdMiddleware(req, res, next);

    expect(req.requestId).toBe('incoming-request-id');
    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'incoming-request-id');
    expect(nextMock).toHaveBeenCalledTimes(1);
  });

  it('generates a UUID request id when the header is absent', () => {
    const { req, res, setHeader, next, nextMock } = buildMiddlewareHarness();

    requestIdMiddleware(req, res, next);

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(setHeader).toHaveBeenCalledWith('x-request-id', req.requestId);
    expect(nextMock).toHaveBeenCalledTimes(1);
  });
});
