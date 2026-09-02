-- 零件采购方式（老板 2026-09-01：外购/自购/自制 3 类，采购单生成按类过滤）+ 套餐价组（外购打包一口价自动分摊）
ALTER TABLE "Part" ADD COLUMN "sourcing" TEXT NOT NULL DEFAULT 'purchased';

CREATE TABLE "PriceBundle" (
    "id" SERIAL NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBundle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PriceBundleItem" (
    "id" SERIAL NOT NULL,
    "bundleId" INTEGER NOT NULL,
    "partId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,4),

    CONSTRAINT "PriceBundleItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PriceBundleItem_bundleId_partId_key" ON "PriceBundleItem"("bundleId", "partId");

ALTER TABLE "PriceBundle" ADD CONSTRAINT "PriceBundle_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceBundleItem" ADD CONSTRAINT "PriceBundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "PriceBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PriceBundleItem" ADD CONSTRAINT "PriceBundleItem_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Part" ADD COLUMN "priceBundleId" INTEGER;
ALTER TABLE "Part" ADD CONSTRAINT "Part_priceBundleId_fkey" FOREIGN KEY ("priceBundleId") REFERENCES "PriceBundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
