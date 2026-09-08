CREATE TABLE "PoTemplate" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "headerType" TEXT NOT NULL DEFAULT 'zrh',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PoTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PoTemplate_name_key" ON "PoTemplate"("name");
ALTER TABLE "PurchaseOrder" ADD COLUMN "templateId" INTEGER;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PoTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
