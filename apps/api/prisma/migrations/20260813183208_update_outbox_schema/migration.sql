/*
  Warnings:

  - Added the required column `aggregate_id` to the `outbox_events` table without a default value. This is not possible if the table is not empty.
  - Added the required column `aggregate_type` to the `outbox_events` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "outbox_events_status_created_at_idx";

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "aggregate_id" TEXT NOT NULL,
ADD COLUMN     "aggregate_type" TEXT NOT NULL,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "next_retry_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "outbox_events_status_next_retry_at_created_at_idx" ON "outbox_events"("status", "next_retry_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events"("aggregate_type", "aggregate_id");
