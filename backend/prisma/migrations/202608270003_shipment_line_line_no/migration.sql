-- Line# 全链路：订单明细行 → 出货明细行 → Official Invoice
-- 1) 订单明细行的 lineNo 由 INTEGER 改为 TEXT（OPO 表行号如 2.1）
ALTER TABLE "SalesOrderItem" ALTER COLUMN "lineNo" TYPE TEXT USING "lineNo"::text;
-- 2) 出货明细行新增 lineNo
ALTER TABLE "ShipmentLine" ADD COLUMN "lineNo" TEXT;
