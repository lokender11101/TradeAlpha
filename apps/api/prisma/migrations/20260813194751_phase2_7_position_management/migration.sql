-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "order_fills" ADD COLUMN     "realized_pnl" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "status" "PositionStatus" NOT NULL DEFAULT 'OPEN';
