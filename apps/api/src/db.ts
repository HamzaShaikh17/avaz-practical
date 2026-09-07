import { PrismaClient } from '@prisma/client';

// Single shared Prisma client for the process. Assumes DATABASE_URL is
// already present in process.env by the time this module is imported —
// see src/index.ts (loads .env) and test/setup.ts (vitest injects it).
export const prisma = new PrismaClient();
