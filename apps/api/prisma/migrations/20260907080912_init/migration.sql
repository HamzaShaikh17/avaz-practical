-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SessionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceSeq" INTEGER NOT NULL,
    "clientTimestamp" DATETIME NOT NULL,
    "tileId" TEXT,
    "phraseText" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Session_deviceId_idx" ON "Session"("deviceId");

-- CreateIndex
CREATE INDEX "SessionEvent_sessionId_deviceSeq_idx" ON "SessionEvent"("sessionId", "deviceSeq");

-- CreateIndex
CREATE INDEX "SessionEvent_deviceId_clientTimestamp_idx" ON "SessionEvent"("deviceId", "clientTimestamp");

-- CreateIndex
CREATE UNIQUE INDEX "SessionEvent_deviceId_deviceSeq_key" ON "SessionEvent"("deviceId", "deviceSeq");
