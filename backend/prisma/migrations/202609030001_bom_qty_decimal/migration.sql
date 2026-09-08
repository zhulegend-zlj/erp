-- 用量支持小数：Int → Decimal(12,4)
ALTER TABLE "Bom" ALTER COLUMN "qty" TYPE DECIMAL(12,4);
