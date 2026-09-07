import cors from 'cors';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { HttpError } from './http-error';
import { healthRouter } from './routes/health';
import { sessionsRouter } from './routes/sessions';
import { syncRouter } from './routes/sync';

const WEB_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

/**
 * Builds the Express app without starting it — kept separate from
 * src/index.ts so tests (vitest + supertest) can exercise the app directly
 * without binding a port.
 */
export function createApp() {
  const app = express();

  app.use(cors({ origin: WEB_ORIGIN }));
  app.use(express.json());

  app.use(healthRouter);
  app.use('/api', syncRouter);
  app.use('/api', sessionsRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res
      .status(err.status)
      .json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }

  // express.json() throws a SyntaxError (with a `status`/`statusCode` of
  // 400) on malformed JSON bodies.
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
