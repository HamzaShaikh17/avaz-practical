import { Router } from 'express';
import type { SessionEvent, SyncPushResponse } from '@session-replay/shared';
import { prisma } from '../db';
import { asyncHandler } from '../async-handler';
import { HttpError } from '../http-error';
import {
  CloseSessionBodySchema,
  parseOrThrow,
  SyncPullQuerySchema,
  SyncPushRequestSchema,
} from '../validation';
import { toSessionDTO, toSessionEventDTO } from '../dto';

export const syncRouter = Router();

/**
 * POST /api/sync/push
 *
 * Idempotent by event id: an id already present in the DB (or repeated
 * within the same request body) is reported in `duplicates`, not treated as
 * an error — clients retry pushes after network failures, so a duplicate is
 * an expected, normal outcome, not a bug.
 *
 * Sessions are created on demand from the first event that references them
 * (startedAt = the earliest clientTimestamp among this batch's events for
 * that session) rather than requiring the session to exist first — events
 * and their session's own bookkeeping can arrive interleaved or out of
 * order, and dropping an event just because its session hasn't landed yet
 * would lose part of the transcript.
 *
 * The whole batch — duplicate detection, session creation, event insertion —
 * runs in one transaction so a partial failure can't leave a session created
 * with none of its events, or vice versa.
 */
syncRouter.post(
  '/sync/push',
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(SyncPushRequestSchema, req.body, 'Invalid push request body');
    const events = body.events as SessionEvent[];

    const response = await prisma.$transaction(async (tx) => {
      const accepted: string[] = [];
      const duplicates: string[] = [];

      if (events.length === 0) {
        return { accepted, duplicates } satisfies SyncPushResponse;
      }

      const incomingIds = events.map((e) => e.id);
      const existingEvents = await tx.sessionEvent.findMany({
        where: { id: { in: incomingIds } },
        select: { id: true },
      });
      const existingIds = new Set(existingEvents.map((e) => e.id));

      // De-dupe within the batch too: a client retry could resend the same
      // id twice in one request, not just across requests.
      const seenInBatch = new Set<string>();
      const toInsert: SessionEvent[] = [];
      for (const event of events) {
        if (existingIds.has(event.id) || seenInBatch.has(event.id)) {
          duplicates.push(event.id);
          continue;
        }
        seenInBatch.add(event.id);
        accepted.push(event.id);
        toInsert.push(event);
      }

      if (toInsert.length === 0) {
        return { accepted, duplicates } satisfies SyncPushResponse;
      }

      // Ensure every referenced session exists before inserting events that
      // point at it (SessionEvent.sessionId is a foreign key).
      const neededSessionIds = [...new Set(toInsert.map((e) => e.sessionId))];
      const existingSessions = await tx.session.findMany({
        where: { id: { in: neededSessionIds } },
        select: { id: true },
      });
      const existingSessionIds = new Set(existingSessions.map((s) => s.id));
      const missingSessionIds = neededSessionIds.filter((id) => !existingSessionIds.has(id));

      for (const sessionId of missingSessionIds) {
        const eventsForSession = toInsert.filter((e) => e.sessionId === sessionId);
        const earliest = eventsForSession.reduce((min, e) =>
          e.clientTimestamp < min.clientTimestamp ? e : min,
        );
        const ticket = await tx.syncSeq.create({ data: {} });
        await tx.session.create({
          data: {
            id: sessionId,
            deviceId: earliest.deviceId,
            startedAt: new Date(earliest.clientTimestamp),
            endedAt: null,
            serverSeq: ticket.seq,
          },
        });
      }

      for (const event of toInsert) {
        const ticket = await tx.syncSeq.create({ data: {} });
        await tx.sessionEvent.create({
          data: {
            id: event.id,
            type: event.type,
            sessionId: event.sessionId,
            deviceId: event.deviceId,
            deviceSeq: event.deviceSeq,
            clientTimestamp: new Date(event.clientTimestamp),
            tileId: event.type === 'tile_tap' ? event.tileId : null,
            phraseText: event.type === 'tile_tap' ? event.phraseText : null,
            serverSeq: ticket.seq,
          },
        });
      }

      return { accepted, duplicates } satisfies SyncPushResponse;
    });

    res.status(200).json(response);
  }),
);

/**
 * POST /api/sync/sessions/:sessionId/close
 *
 * Idempotent: a session that's already closed is left untouched (its
 * original endedAt wins) and this still returns 200 — a device may send a
 * close more than once (e.g. idle-timeout fired, then backgrounding also
 * fired), and neither should be treated as an error.
 */
syncRouter.post(
  '/sync/sessions/:sessionId/close',
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const body = parseOrThrow(CloseSessionBodySchema, req.body, 'Invalid close request body');

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new HttpError(404, `Session ${sessionId} not found`);
    }

    if (session.endedAt) {
      res.status(200).json({ session: toSessionDTO(session) });
      return;
    }

    const ticket = await prisma.syncSeq.create({ data: {} });
    const updated = await prisma.session.update({
      where: { id: sessionId },
      data: { endedAt: new Date(body.endedAt), serverSeq: ticket.seq },
    });

    res.status(200).json({ session: toSessionDTO(updated) });
  }),
);

/**
 * GET /api/sync/pull?since=<cursor>
 *
 * Pages by serverSeq (server insertion/update order), never by
 * clientTimestamp — see the SyncSeq comment in schema.prisma for why a
 * client clock can't be trusted for this. Omitting `since` pulls everything,
 * which is what a fresh device/browser profile does on first load.
 */
syncRouter.get(
  '/sync/pull',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(SyncPullQuerySchema, req.query, 'Invalid pull query parameters');
    const since = query.since ? Number(query.since) : undefined;
    const cursorFilter = since !== undefined ? { serverSeq: { gt: since } } : undefined;

    const [events, sessions] = await Promise.all([
      prisma.sessionEvent.findMany({ where: cursorFilter, orderBy: { serverSeq: 'asc' } }),
      prisma.session.findMany({ where: cursorFilter, orderBy: { serverSeq: 'asc' } }),
    ]);

    // Max serverSeq observed in this response; falls back to the incoming
    // cursor (or 0) when there's nothing new, so a client that's fully
    // caught up doesn't get its cursor reset.
    const maxSeq = Math.max(
      since ?? 0,
      ...events.map((e) => e.serverSeq),
      ...sessions.map((s) => s.serverSeq),
    );

    res.status(200).json({
      events: events.map(toSessionEventDTO),
      sessions: sessions.map(toSessionDTO),
      cursor: String(maxSeq),
    });
  }),
);
