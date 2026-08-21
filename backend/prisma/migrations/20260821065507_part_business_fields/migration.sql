-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "drawingsUrl" TEXT,
ADD COLUMN     "moq" INTEGER,
ADD COLUMN     "price" DECIMAL(12,4),
ADD COLUMN     "tooling" TEXT;
