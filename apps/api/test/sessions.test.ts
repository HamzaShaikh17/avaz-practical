import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { TapEvent } from '@session-replay/shared';
import { createApp } from '../src/app';

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

describe('GET /api/sessions/:id/events', () => {
  it('orders events from two devices with overlapping timestamps per the Phase 1 rule', async () => {
    // Rule under test (packages/shared/src/types.ts, mirrored in this
    // route's ORDER BY): within a device, deviceSeq; across devices,
    // clientTimestamp, with deviceId as the final tiebreak for an exact
    // timestamp tie. Zero test coverage existed for this endpoint before
    // this test — the client-side equivalent (getEventsForSession) has its
    // own, independent implementation of the same rule, and the two can
    // silently drift from each other without a test on both.
    const sessionId = randomUUID();

    // deviceId is a genuine UUID (the API validates it as one), so sort
    // two real ids to know which one wins the deviceId tiebreak, rather
    // than hardcoding an assumed order.
    const [deviceLower, deviceHigher] = [randomUUID(), randomUUID()].sort();

    const a1 = makeTapEvent({
      sessionId,
      deviceId: deviceLower,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T08:00:00.000Z',
      phraseText: 'a1',
    });
    // Genuinely interleaves with deviceLower's own sequence: later than
    // a1, earlier than a2.
    const b1 = makeTapEvent({
      sessionId,
      deviceId: deviceHigher,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T08:00:02.000Z',
      phraseText: 'b1',
    });
    // a2 and b2 share the exact same clientTimestamp — an honest
    // cross-device tie, resolved by deviceId (deviceLower < deviceHigher).
    const a2 = makeTapEvent({
      sessionId,
      deviceId: deviceLower,
      deviceSeq: 2,
      clientTimestamp: '2026-09-07T08:00:05.000Z',
      phraseText: 'a2',
    });
    const b2 = makeTapEvent({
      sessionId,
      deviceId: deviceHigher,
      deviceSeq: 2,
      clientTimestamp: '2026-09-07T08:00:05.000Z',
      phraseText: 'b2',
    });

    // Pushed as two separate requests (as two real devices independently
    // syncing would), each internally out of order too, so this can only
    // pass if the endpoint's ORDER BY does the work rather than the result
    // happening to reflect push/insertion order.
    const pushB = await request(app)
      .post('/api/sync/push')
      .send({ deviceId: deviceHigher, events: [b2, b1] });
    expect(pushB.status).toBe(200);
    const pushA = await request(app)
      .post('/api/sync/push')
      .send({ deviceId: deviceLower, events: [a2, a1] });
    expect(pushA.status).toBe(200);

    const res = await request(app).get(`/api/sessions/${sessionId}/events`);

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { phraseText: string }) => e.phraseText)).toEqual([
      'a1',
      'b1',
      'a2',
      'b2',
    ]);
  });

  it('breaks a same-device, same-timestamp tie by deviceSeq', async () => {
    // Rare (two taps landing in the same millisecond on one device), but
    // the ordering rule's final tiebreak specifically covers it.
    const sessionId = randomUUID();
    const deviceId = randomUUID();
    const sameTimestamp = '2026-09-07T08:00:00.000Z';

    const second = makeTapEvent({
      sessionId,
      deviceId,
      deviceSeq: 2,
      clientTimestamp: sameTimestamp,
      phraseText: 'second',
    });
    const first = makeTapEvent({
      sessionId,
      deviceId,
      deviceSeq: 1,
      clientTimestamp: sameTimestamp,
      phraseText: 'first',
    });

    // Pushed in reverse (deviceSeq 2 before deviceSeq 1) in one request.
    const push = await request(app)
      .post('/api/sync/push')
      .send({ deviceId, events: [second, first] });
    expect(push.status).toBe(200);

    const res = await request(app).get(`/api/sessions/${sessionId}/events`);

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { phraseText: string }) => e.phraseText)).toEqual([
      'first',
      'second',
    ]);
  });
});
