import type { Session as PrismaSession, SessionEvent as PrismaSessionEvent } from '@prisma/client';
import type { Session, SessionEvent } from '@session-replay/shared';

/** DB row -> wire shape. Strips internal-only columns (serverSeq, receivedAt). */
export function toSessionDTO(session: PrismaSession): Session {
  return {
    id: session.id,
    deviceId: session.deviceId,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
  };
}

/** DB row -> wire shape, reconstructing the TapEvent | ClearBarEvent union. */
export function toSessionEventDTO(event: PrismaSessionEvent): SessionEvent {
  const base = {
    id: event.id,
    sessionId: event.sessionId,
    deviceId: event.deviceId,
    deviceSeq: event.deviceSeq,
    clientTimestamp: event.clientTimestamp.toISOString(),
  };

  if (event.type === 'tile_tap') {
    return {
      ...base,
      type: 'tile_tap',
      // Non-null by construction: the push handler only ever writes these
      // for tile_tap rows (see routes/sync.ts).
      tileId: event.tileId ?? '',
      phraseText: event.phraseText ?? '',
    };
  }

  return {
    ...base,
    type: 'clear_bar',
  };
}
