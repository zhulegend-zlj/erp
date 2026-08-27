-- 订单明细行增加 客户PO行号 Line#（销售手动录入）
ALTER TABLE "SalesOrderItem" ADD COLUMN "lineNo" INTEGER;
