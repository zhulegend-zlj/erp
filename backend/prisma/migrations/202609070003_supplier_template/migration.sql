ALTER TABLE "Supplier" ADD COLUMN "poTemplateId" INTEGER;
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_poTemplateId_fkey" FOREIGN KEY ("poTemplateId") REFERENCES "PoTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
