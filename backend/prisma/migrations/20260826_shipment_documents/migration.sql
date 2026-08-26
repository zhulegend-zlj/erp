-- 出货单证功能：客户/成品单证字段 + 公司抬头配置 + 出货明细行
-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "address" TEXT,
ADD COLUMN "vatNo" TEXT,
ADD COLUMN "eori" TEXT,
ADD COLUMN "notifyParty" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "nameEn" TEXT,
ADD COLUMN "hsCode" TEXT;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN "invoiceNo" TEXT,
ADD COLUMN "paymentTerms" TEXT,
ADD COLUMN "incoterm" TEXT,
ADD COLUMN "mark" TEXT,
ADD COLUMN "origin" TEXT,
ADD COLUMN "hsCode" TEXT,
ADD COLUMN "taxRate" TEXT,
ADD COLUMN "vesselVoyage" TEXT,
ADD COLUMN "etd" TIMESTAMP(3),
ADD COLUMN "eta" TIMESTAMP(3),
ADD COLUMN "shippingInstructions" TEXT;

-- CreateTable
CREATE TABLE "CompanyProfile" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "contact" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "vatNo" TEXT NOT NULL DEFAULT '',
    "taxRate" TEXT NOT NULL DEFAULT '0',
    "bankName" TEXT NOT NULL DEFAULT '',
    "bankPhone" TEXT NOT NULL DEFAULT '',
    "bankAddress" TEXT NOT NULL DEFAULT '',
    "swift" TEXT NOT NULL DEFAULT '',
    "accountName" TEXT NOT NULL DEFAULT '',
    "accountNo" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentLine" (
    "id" SERIAL NOT NULL,
    "shipmentId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "customerPoNo" TEXT,
    "lotNo" TEXT,
    "cartons" INTEGER,
    "netWeight" DECIMAL(12,3),
    "grossWeight" DECIMAL(12,3),
    "cbm" DECIMAL(12,4),
    "containerNo" TEXT,
    "sealNo" TEXT,
    "hblNo" TEXT,
    "remark" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ShipmentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShipmentLine_shipmentId_idx" ON "ShipmentLine"("shipmentId");

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
