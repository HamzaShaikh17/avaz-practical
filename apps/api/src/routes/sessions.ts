import { Router } from 'express';
import type { Session } from '@session-replay/shared';
import { prisma } from '../db';
import { asyncHandler } from '../async-handler';
import { HttpError } from '../http-error';
import { toSessionDTO, toSessionEventDTO } from '../dto';

export const sessionsRouter = Router();

type SessionSummary = Session & {
  eventCount: number;
  firstTapAt: string | null;
  lastTapAt: string | null;
};

/**
 * GET /api/sessions
 *
 * List endpoint for the caregiver UI: every session plus its total event
 * count and the time range of its tile_tap events specifically (clear_bar
 * events don't represent "something said", so they're excluded from
 * first/last tap time).
 */
sessionsRouter.get(
  '/sessions',
  asyncHandler(async (_req, res) => {
    const sessions = await prisma.session.findMany({ orderBy: { startedAt: 'desc' } });

    const [countGroups, tapGroups] = await Promise.all([
      prisma.sessionEvent.groupBy({ by: ['sessionId'], _count: { _all: true } }),
      prisma.sessionEvent.groupBy({
        by: ['sessionId'],
        where: { type: 'tile_tap' },
        _min: { clientTimestamp: true },
        _max: { clientTimestamp: true },
      }),
    ]);

    const countBySessionId = new Map(countGroups.map((g) => [g.sessionId, g._count._all]));
    const tapRangeBySessionId = new Map(
      tapGroups.map((g) => [
        g.sessionId,
        { first: g._min.clientTimestamp, last: g._max.clientTimestamp },
      ]),
    );

    const summaries: SessionSummary[] = sessions.map((session) => {
      const tapRange = tapRangeBySessionId.get(session.id);
      return {
        ...toSessionDTO(session),
        eventCount: countBySessionId.get(session.id) ?? 0,
        firstTapAt: tapRange?.first ? tapRange.first.toISOString() : null,
        lastTapAt: tapRange?.last ? tapRange.last.toISOString() : null,
      };
    });

    res.status(200).json({ sessions: summaries });
  }),
);

/**
 * GET /api/sessions/:id/events
 *
 * Full event list for one session, in the ordering rule from
 * packages/shared/src/types.ts: within a device, order is deviceSeq; across
 * devices, clientTimestamp with deviceId as the tiebreak for equal
 * timestamps. A single ORDER BY (clientTimestamp, deviceId, deviceSeq)
 * satisfies both — deviceSeq only comes into play as a final tiebreak on an
 * exact clientTimestamp+deviceId match, which (since a device's own clock
 * only advances alongside its own deviceSeq) only happens for same-device
 * events landing in the same clock tick.
 */
sessionsRouter.get(
  '/sessions/:id/events',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) {
      throw new HttpError(404, `Session ${id} not found`);
    }

    const events = await prisma.sessionEvent.findMany({
      where: { sessionId: id },
      orderBy: [{ clientTimestamp: 'asc' }, { deviceId: 'asc' }, { deviceSeq: 'asc' }],
    });

    res.status(200).json({
      session: toSessionDTO(session),
      events: events.map(toSessionEventDTO),
    });
  }),
);
