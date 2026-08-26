-- 销售流程重构：订单字段（PO号/订单日期/客户交期/ZRH交货日期/付款条件）、客户单证默认值、
-- 到货仓字典、出货排程、跨订单拼票（行级订单）、一单一仓
-- AlterTable
ALTER TABLE "SalesOrder" RENAME COLUMN "deliveryDate" TO "zrhDeliveryDate";
ALTER TABLE "SalesOrder" ADD COLUMN "customerPoNo" TEXT,
ADD COLUMN "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "customerDeliveryDate" TIMESTAMP(3),
ADD COLUMN "paymentTerms" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "defaultPaymentTerms" TEXT,
ADD COLUMN "defaultIncoterm" TEXT,
ADD COLUMN "defaultMark" TEXT,
ADD COLUMN "defaultTaxRate" TEXT;

-- CreateTable
CREATE TABLE "ShipToHub" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShipToHub_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentSchedule" (
    "id" SERIAL NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "hubId" INTEGER NOT NULL,
    "needByDate" TIMESTAMP(3) NOT NULL,
    "promisedDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "shipmentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShipmentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShipToHub_name_key" ON "ShipToHub"("name");

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN "hubId" INTEGER;

-- AlterTable
ALTER TABLE "ShipmentLine" ADD COLUMN "salesOrderId" INTEGER,
ADD COLUMN "scheduleId" INTEGER;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "ShipToHub"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ShipmentSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ShipmentSchedule" ADD CONSTRAINT "ShipmentSchedule_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentSchedule" ADD CONSTRAINT "ShipmentSchedule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentSchedule" ADD CONSTRAINT "ShipmentSchedule_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "ShipToHub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
