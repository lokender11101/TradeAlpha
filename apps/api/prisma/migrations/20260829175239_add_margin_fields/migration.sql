-- AlterTable
ALTER TABLE "portfolios" ADD COLUMN     "is_margin_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "locked_margin" DECIMAL(19,4) NOT NULL DEFAULT 0;
