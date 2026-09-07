import type { NextFunction, Request, Response } from 'express';

/**
 * Express 4 doesn't forward rejected promises from async route handlers to
 * the error middleware on its own — this wraps a handler so a thrown/rejected
 * error reaches `next(err)` instead of crashing the process unhandled.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
