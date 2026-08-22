-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "producing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "purchasing" BOOLEAN NOT NULL DEFAULT false;
