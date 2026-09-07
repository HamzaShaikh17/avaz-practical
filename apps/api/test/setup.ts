import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/db';

beforeEach(async () => {
  // FK order matters: events reference sessions.
  await prisma.sessionEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.syncSeq.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});
