-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "defectiveQty" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lotNo" TEXT,
ADD COLUMN     "qcStatus" TEXT;
