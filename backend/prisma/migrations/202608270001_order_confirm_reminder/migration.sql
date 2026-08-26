-- 采购催销售确认订单：草稿订单无法生成采购单时，采购可一键提醒销售确认
-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN "confirmReminderAt" TIMESTAMP(3),
ADD COLUMN "confirmReminderBy" TEXT;
