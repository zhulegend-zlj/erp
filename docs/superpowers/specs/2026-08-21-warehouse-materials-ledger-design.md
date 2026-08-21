# 仓库订单物料计算 / 流水增强 / 物料图片 设计规格

- 日期：2026-08-21
- 状态：待实施

## 目标

1. 物料（零件/成品）支持图片 URL，零件支持规格和供应商。
2. 库存流水支持按销售订单号查询，并汇总该订单出库数量；变动显示为带符号数量（入库 +N，出库 -N）。
3. 仓库主目录新增「订单物料计算」Tab：按销售订单号计算零件需求、已出库、差值，布局参考用户提供的 Excel。
4. 收货/领料/成品入库后自动刷新库存和流水。

## 数据模型变更

- Part：新增 `spec String?`、`imageUrl String?`、`supplierId Int?`，supplierId 关联 Supplier。
- Product：新增 `imageUrl String?`。
- InventoryLedger：新增 `salesOrderId Int?`，关联 SalesOrder。

## 后端接口

- `GET /api/inventory/order-materials?orderNo=<销售订单号>`：
  - 返回 orderNo、orderQty、items[]。
  - items 字段：partId、sku、name、imageUrl、supplierName、spec、usage（每单位用量）、requiredQty、issuedQty、variance。
  - 需求按 BOM 展开并跨订单明细汇总；issuedQty 为该订单领料出库合计；variance = issuedQty - requiredQty。
- `GET /api/inventory/order-ledger?orderNo=<销售订单号>`：
  - 返回该订单所有流水（含物料名称、订单号），并汇总出库数量 totalOutboundQty。
- `applyStockChange` 增加可选 `salesOrderId`，写流水时保存。
- 零件/成品 CRUD 接受并保存 `spec`、`imageUrl`、`supplierId`。

## 前端变更

- 基础资料：零件表单增加规格、图片地址、供应商下拉；成品表单增加图片地址；列表显示图片缩略图。
- 库存页：
  - 新增 Tab「订单物料计算」：选择销售订单并展示统计表。
  - 流水 Tab：支持按订单号查询、显示汇总；变动列带符号。
  - 收货/领料/成品入库提交后刷新库存与流水。

## 测试

- 后端：订单物料计算、订单流水查询与汇总、流水写订单号、CRUD 新字段。
- 前端 build、后端 typecheck、vitest 全绿。

