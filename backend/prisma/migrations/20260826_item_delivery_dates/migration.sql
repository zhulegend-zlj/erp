-- 交期下放到订单明细行：同一张订单不同成品可有不同客户交期/ZRH交货日期
-- 1) SalesOrder 旧订单级两列保留但改为可空（不再使用，兼容历史数据）
ALTER TABLE "SalesOrder" ALTER COLUMN "zrhDeliveryDate" DROP NOT NULL;
-- 2) SalesOrderItem 新增行级两列
ALTER TABLE "SalesOrderItem" ADD COLUMN "customerDeliveryDate" TIMESTAMP(3);
ALTER TABLE "SalesOrderItem" ADD COLUMN "zrhDeliveryDate" TIMESTAMP(3);
