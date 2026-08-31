-- 销售单拆单：拆出的子订单记录来源订单（老板反馈 2026-08-31）
ALTER TABLE "SalesOrder" ADD COLUMN "parentOrderId" INTEGER;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
