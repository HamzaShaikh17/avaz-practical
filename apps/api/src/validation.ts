import { z } from 'zod';
import { HttpError } from './http-error';

/**
 * Mirrors packages/shared/src/types.ts. Kept as zod schemas (rather than
 * generated from the types) since the types are plain type aliases with no
 * runtime representation — this is the runtime validation layer at the
 * HTTP boundary, the shared package stays framework/validation-agnostic.
 */

const TapEventSchema = z.object({
  id: z.string().uuid(),
  type: z.literal('tile_tap'),
  sessionId: z.string().uuid(),
  deviceId: z.string().uuid(),
  deviceSeq: z.number().int().nonnegative(),
  clientTimestamp: z.string().datetime(),
  tileId: z.string().min(1),
  phraseText: z.string(),
});

const ClearBarEventSchema = z.object({
  id: z.string().uuid(),
  type: z.literal('clear_bar'),
  sessionId: z.string().uuid(),
  deviceId: z.string().uuid(),
  deviceSeq: z.number().int().nonnegative(),
  clientTimestamp: z.string().datetime(),
});

export const SessionEventSchema = z.discriminatedUnion('type', [
  TapEventSchema,
  ClearBarEventSchema,
]);

export const SyncPushRequestSchema = z.object({
  deviceId: z.string().uuid(),
  events: z.array(SessionEventSchema),
});

export const CloseSessionBodySchema = z.object({
  endedAt: z.string().datetime(),
});

// `since` is the opaque cursor from SyncPullResponse.cursor — in this
// implementation that's a stringified serverSeq, so validate it as a
// non-negative integer string rather than treating it as truly opaque.
export const SyncPullQuerySchema = z.object({
  since: z.string().regex(/^\d+$/, 'since must be a non-negative integer string').optional(),
});

/**
 * Parses `data` against `schema`, throwing an HttpError(400) with the zod
 * error details on failure. Used inline in route handlers so validation
 * failures flow through the same error-handling middleware as everything
 * else.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, message: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, message, result.error.flatten());
  }
  return result.data;
}
