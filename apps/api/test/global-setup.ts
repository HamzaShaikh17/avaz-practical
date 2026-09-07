import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

// A dedicated SQLite file for the test run, separate from prisma/dev.db so
// tests never touch (or depend on) local dev data. Runs once for the whole
// vitest run (vitest globalSetup), in a separate process from the test files
// themselves.
const apiRoot = path.resolve(__dirname, '..');
const testDbPath = path.join(apiRoot, 'prisma', 'test.db');
// Relative to prisma/schema.prisma's own directory (how Prisma resolves a
// sqlite `file:` URL) — not relative to cwd, so this stays correct
// regardless of where the command is invoked from.
const testDatabaseUrl = 'file:./test.db';

function removeIfExists(filePath: string) {
  if (existsSync(filePath)) rmSync(filePath);
}

export async function setup() {
  removeIfExists(testDbPath);
  removeIfExists(`${testDbPath}-journal`);

  // `db push` syncs the schema directly without generating migration
  // history — appropriate for a throwaway, always-fresh test database.
  execSync('npx prisma db push --skip-generate', {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: 'inherit',
  });
}

export async function teardown() {
  removeIfExists(testDbPath);
  removeIfExists(`${testDbPath}-journal`);
}
