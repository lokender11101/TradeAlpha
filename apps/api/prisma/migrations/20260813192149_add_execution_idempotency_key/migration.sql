/*
  Warnings:

  - The required column `execution_idempotency_key` was added to the `order_fills` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- AlterTable
ALTER TABLE "order_fills" ADD COLUMN     "execution_idempotency_key" TEXT NOT NULL;
