import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { TapEvent } from '@session-replay/shared';
import { createApp } from '../src/app';
import { prisma } from '../src/db';

const app = createApp();

function makeTapEvent(overrides: Partial<TapEvent> = {}): TapEvent {
  return {
    id: randomUUID(),
    type: 'tile_tap',
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    deviceSeq: 1,
    clientTimestamp: new Date().toISOString(),
    tileId: 'tile-hello',
    phraseText: 'hello',
    ...overrides,
  };
}

describe('GET /health', () => {
  it('reports ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /api/sync/push', () => {
  it('is idempotent: pushing the same event twice is a no-op the second time', async () => {
    const deviceId = randomUUID();
    const event = makeTapEvent({ deviceId });

    const first = await request(app)
      .post('/api/sync/push')
      .send({ deviceId, events: [event] });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ accepted: [event.id], duplicates: [] });

    const second = await request(app)
      .post('/api/sync/push')
      .send({ deviceId, events: [event] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ accepted: [], duplicates: [event.id] });

    // Only one row was ever persisted for this id.
    const rows = await prisma.sessionEvent.findMany({ where: { id: event.id } });
    expect(rows).toHaveLength(1);
  });

  it('creates the session on demand when events reference a sessionId that does not exist yet', async () => {
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const clientTimestamp = new Date().toISOString();
    const event = makeTapEvent({ deviceId, sessionId, deviceSeq: 1, clientTimestamp });

    // Sanity check: the session genuinely doesn't exist before the push.
    expect(await prisma.session.findUnique({ where: { id: sessionId } })).toBeNull();

    const res = await request(app)
      .post('/api/sync/push')
      .send({ deviceId, events: [event] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: [event.id], duplicates: [] });

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(session).not.toBeNull();
    expect(session?.deviceId).toBe(deviceId);
    expect(session?.startedAt.toISOString()).toBe(clientTimestamp);
    expect(session?.endedAt).toBeNull();
  });

  it('rejects a malformed payload with 400 and validation details', async () => {
    const res = await request(app)
      .post('/api/sync/push')
      .send({ deviceId: 'not-a-uuid', events: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTypeOf('string');
    expect(res.body.details).toBeDefined();
  });
});

describe('GET /api/sync/pull', () => {
  it('only returns events inserted after the given cursor', async () => {
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const eventA = makeTapEvent({ deviceId, sessionId, deviceSeq: 1 });

    await request(app)
      .post('/api/sync/push')
      .send({ deviceId, events: [eventA] });

    const firstPull = await request(app).get('/api/sync/pull');
    expect(firstPull.status).toBe(200);
    expect(firstPull.body.events.map((e: TapEvent) => e.id)).toContain(eventA.id);
    const cursorAfterA: string = firstPull.body.cursor;
    expect(typeof cursorAfterA).toBe('string');

    const eventB = makeTapEvent({ deviceId, sessionId, deviceSeq: 2 });
    await request(app)
      .post('/api/sync/push')
      .send({ deviceId, events: [eventB] });

    const secondPull = await request(app).get('/api/sync/pull').query({ since: cursorAfterA });

    expect(secondPull.status).toBe(200);
    const ids = secondPull.body.events.map((e: TapEvent) => e.id);
    expect(ids).toEqual([eventB.id]);
    expect(ids).not.toContain(eventA.id);

    // Polling again with the new cursor and nothing new since: cursor holds
    // steady instead of resetting.
    const thirdPull = await request(app)
      .get('/api/sync/pull')
      .query({ since: secondPull.body.cursor });
    expect(thirdPull.body.events).toEqual([]);
    expect(thirdPull.body.cursor).toBe(secondPull.body.cursor);
  });

  it('surfaces a session update (not just new events) through the same cursor, per the SyncSeq design in schema.prisma', async () => {
    // Sessions can be mutated after creation (closed), with no new events
    // involved at all. Under a naive "serverSeq = creation order only"
    // design this update would never become visible to a client that
    // already pulled past the session's original row — this is exactly
    // what the SyncSeq shared-counter mechanism exists to fix, and it had
    // no test coverage before this one.
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const event = makeTapEvent({ deviceId, sessionId, deviceSeq: 1 });

    await request(app)
      .post('/api/sync/push')
      .send({ deviceId, events: [event] });

    // Fresh pull, no cursor: a brand-new device's first sync sees
    // everything that exists so far — the event and its auto-created session.
    const freshPull = await request(app).get('/api/sync/pull');
    expect(freshPull.status).toBe(200);
    expect(freshPull.body.events.map((e: TapEvent) => e.id)).toEqual([event.id]);
    expect(freshPull.body.sessions.map((s: { id: string }) => s.id)).toEqual([sessionId]);
    const cursorAfterCreate: string = freshPull.body.cursor;

    // No new events — only the session gets closed.
    const closeRes = await request(app)
      .post(`/api/sync/sessions/${sessionId}/close`)
      .send({ endedAt: new Date().toISOString() });
    expect(closeRes.status).toBe(200);

    const pullAfterClose = await request(app)
      .get('/api/sync/pull')
      .query({ since: cursorAfterCreate });

    expect(pullAfterClose.status).toBe(200);
    expect(pullAfterClose.body.events).toEqual([]); // nothing new event-wise
    expect(pullAfterClose.body.sessions).toHaveLength(1);
    expect(pullAfterClose.body.sessions[0].id).toBe(sessionId);
    expect(pullAfterClose.body.sessions[0].endedAt).not.toBeNull();

    // Caught up on that update too: pulling again with the newest cursor
    // returns nothing further.
    const pullAfterThat = await request(app)
      .get('/api/sync/pull')
      .query({ since: pullAfterClose.body.cursor });
    expect(pullAfterThat.body.events).toEqual([]);
    expect(pullAfterThat.body.sessions).toEqual([]);
  });
});
