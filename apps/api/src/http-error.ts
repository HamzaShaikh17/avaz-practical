/**
 * An error with an HTTP status attached. Route handlers throw this (directly,
 * or via asyncHandler catching a rejected promise); the error-handling
 * middleware in app.ts turns it into the { error, details? } JSON shape.
 */
export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}
