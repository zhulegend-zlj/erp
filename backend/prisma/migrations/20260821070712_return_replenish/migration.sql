-- CreateTable
CREATE TABLE "ReturnReplenish" (
    "id" SERIAL NOT NULL,
    "partId" INTEGER NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "returnDate" TIMESTAMP(3),
    "returnQty" INTEGER NOT NULL DEFAULT 0,
    "replenishDate" TIMESTAMP(3),
    "replenishQty" INTEGER NOT NULL DEFAULT 0,
    "purchaseOrderNo" TEXT,
    "lotNo" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnReplenish_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ReturnReplenish" ADD CONSTRAINT "ReturnReplenish_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnReplenish" ADD CONSTRAINT "ReturnReplenish_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
