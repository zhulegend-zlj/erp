-- DropIndex

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "leadTime" TEXT,
ADD COLUMN     "priceInclTax" DECIMAL(12,4),
ADD COLUMN     "safetyStock" INTEGER;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "expectedDeliveryDate" TEXT,
ADD COLUMN     "headerName" TEXT,
ADD COLUMN     "orderDate" TIMESTAMP(3),
ADD COLUMN     "paymentTerms" TEXT,
ADD COLUMN     "poStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "poType" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN     "taxPoint" DECIMAL(5,2),
ADD COLUMN     "termsNote" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "note" TEXT,
ADD COLUMN     "supplierReplyDate" TIMESTAMP(3),
ADD COLUMN     "unitPriceInclTax" DECIMAL(12,2),
ADD COLUMN     "usage" INTEGER;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "consigned" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "contactPerson" TEXT,
ADD COLUMN     "defaultHeaderName" TEXT,
ADD COLUMN     "defaultPaymentTerms" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "fax" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "taxPoint" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "CompanyHeader" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "tel" TEXT,
    "fax" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyHeader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderSalesOrder" (
    "id" SERIAL NOT NULL,
    "purchaseOrderId" INTEGER NOT NULL,
    "salesOrderId" INTEGER NOT NULL,

    CONSTRAINT "PurchaseOrderSalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderAttachment" (
    "id" SERIAL NOT NULL,
    "purchaseOrderId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderEditLog" (
    "id" SERIAL NOT NULL,
    "purchaseOrderId" INTEGER NOT NULL,
    "beforeJson" TEXT NOT NULL,
    "afterJson" TEXT NOT NULL,
    "editedBy" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderEditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyHeader_name_key" ON "CompanyHeader"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderSalesOrder_purchaseOrderId_salesOrderId_key" ON "PurchaseOrderSalesOrder"("purchaseOrderId", "salesOrderId");

-- AddForeignKey
ALTER TABLE "PurchaseOrderSalesOrder" ADD CONSTRAINT "PurchaseOrderSalesOrder_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderSalesOrder" ADD CONSTRAINT "PurchaseOrderSalesOrder_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderAttachment" ADD CONSTRAINT "PurchaseOrderAttachment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderEditLog" ADD CONSTRAINT "PurchaseOrderEditLog_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

