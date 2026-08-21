-- AlterTable
ALTER TABLE "InventoryLedger" ADD COLUMN     "salesOrderId" INTEGER;

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "spec" TEXT,
ADD COLUMN     "supplierId" INTEGER;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "imageUrl" TEXT;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
