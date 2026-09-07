/*
  Warnings:

  - Added the required column `serverSeq` to the `Session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `serverSeq` to the `SessionEvent` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "SyncSeq" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "serverSeq" INTEGER NOT NULL
);
INSERT INTO "new_Session" ("deviceId", "endedAt", "id", "startedAt") SELECT "deviceId", "endedAt", "id", "startedAt" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE UNIQUE INDEX "Session_serverSeq_key" ON "Session"("serverSeq");
CREATE INDEX "Session_deviceId_idx" ON "Session"("deviceId");
CREATE TABLE "new_SessionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceSeq" INTEGER NOT NULL,
    "clientTimestamp" DATETIME NOT NULL,
    "tileId" TEXT,
    "phraseText" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serverSeq" INTEGER NOT NULL,
    CONSTRAINT "SessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SessionEvent" ("clientTimestamp", "deviceId", "deviceSeq", "id", "phraseText", "receivedAt", "sessionId", "tileId", "type") SELECT "clientTimestamp", "deviceId", "deviceSeq", "id", "phraseText", "receivedAt", "sessionId", "tileId", "type" FROM "SessionEvent";
DROP TABLE "SessionEvent";
ALTER TABLE "new_SessionEvent" RENAME TO "SessionEvent";
CREATE UNIQUE INDEX "SessionEvent_serverSeq_key" ON "SessionEvent"("serverSeq");
CREATE INDEX "SessionEvent_sessionId_deviceSeq_idx" ON "SessionEvent"("sessionId", "deviceSeq");
CREATE INDEX "SessionEvent_deviceId_clientTimestamp_idx" ON "SessionEvent"("deviceId", "clientTimestamp");
CREATE UNIQUE INDEX "SessionEvent_deviceId_deviceSeq_key" ON "SessionEvent"("deviceId", "deviceSeq");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
