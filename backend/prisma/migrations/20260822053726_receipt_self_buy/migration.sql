-- DropForeignKey
ALTER TABLE "Receipt" DROP CONSTRAINT "Receipt_purchaseOrderId_fkey";

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "supplierId" INTEGER,
ALTER COLUMN "purchaseOrderId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
