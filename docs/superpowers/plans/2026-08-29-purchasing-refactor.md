# 采购功能重构 实施计划（第一期）

> Spec: D:\AI\采购\采购重构-总方案.md（v1.1，含六文件口径+数据模型+编号引擎+改/删/留清单）
> 审计: D:\AI\采购\_盘点-后端.md / _盘点-前端.md（带行号）
> 每任务收尾：后端 typecheck+相关测试通过；期末整体 npm test 全绿 + 前端 build + 重启后端 + DEV_HANDOFF.md + commit/push。

## 全局约束
- 后端 Fastify5 + Prisma6 + PG16；tsx 直跑端口 3000；前端 Vite+React18+AntD5 端口 5173
- 迁移同步 erp 与 erp_test 两库；历史采购单不重编号；orderNo 全局唯一
- 成本口径 = unitPrice（不含税）；unitPriceInclTax 仅展示/对账
- 收货/领料/双阶段相位/价格剥离/提醒 逻辑一律不动
- 旧请求体兼容：扩参数不破坏现有字段

## Task 1: Prisma 迁移（schema + 两库 deploy）
文件：backend/prisma/schema.prisma + migrations/<ts>_purchasing_refactor/
- Supplier +contactPerson/phone/fax/email/defaultPaymentTerms/defaultHeaderName/taxPoint
- Part +priceInclTax Decimal(12,4)?/leadTime String?/safetyStock Int?（moq 已有）
- PurchaseOrder +poStatus(默认pending)/poType(默认normal)/orderDate/expectedDeliveryDate/paymentTerms/termsNote/headerName/taxPoint Decimal(5,2)?
- PurchaseOrderItem +usage Int?/unitPriceInclTax Decimal(12,2)?/note String?/supplierReplyDate DateTime?
- Receipt +consigned Boolean @default(false)
- 新模型：CompanyHeader(name唯一/address/tel/fax/email)、PurchaseOrderSalesOrder(purchaseOrderId+salesOrderId, @@unique)、PurchaseOrderAttachment(purchaseOrderId/url/name/uploadedAt)、PurchaseOrderEditLog(purchaseOrderId/beforeJson/afterJson/editedBy/editedAt)
- 步骤：npx prisma migrate dev --name purchasing_refactor → 两库 migrate deploy → prisma generate → typecheck
- 验收：两库迁移 up to date、typecheck 干净

## Task 2: 编号引擎 domain/po-numbering.ts + 测试
- nextLetterSeq(used:Set<string>): 字母 A→Z 跳 I/O
- nextPoLetter(salesOrderNos:string[]): 挂1单=单号+字母（订单内递增）；挂多单=首PO-末PO+字母（合并组内递增）
- nextSparePoNo(linkedOrderNo|null): 订单号+备品（重复加 -2）
- nextSelfBuyPoNo(prefix='PO'): PO-YYYYMMDD-AA/AB/AC 当天递增（两位组合跳 I/O）
- assertOrderNoUnique(tx, orderNo)（手改预检）
- 测试：purchasing 编号新用例（字母递增/跳IO/合并/备品/现金AA/手改冲突）
- 删除 zrhPoSuffix/nextPurchaseOrderNo 旧实现，更新引用

## Task 3: 需求计算升级 + 测试
- domain/bom.ts 新增 computePurchasePlan(requirements, stockMap, partMeta)：gap=需求−库存；safetyStock 触发补货 → 采购量=需求−库存+安全库存；返回 gapQty/suggestedQty/moqHint
- purchasing.ts GET /api/purchasing/requirements：orderId 保留兼容 + orderIds 多值；返回行 +moq/leadTime/safetyStock/priceInclTax/isCommonPart/suggestedQty
- 更新 purchasing.test.ts 旧断言（gapQty 口径不变，新增字段增量），新增安全库存/MOQ/多订单用例

## Task 4: 建单/批量接口扩展 + 测试
- POST /api/purchase-orders、/batch：+salesOrderIds[]（互斥 salesOrderId）、poType/poStatus/orderDate/expectedDeliveryDate/paymentTerms/termsNote/headerName/taxPoint；items +usage/unitPriceInclTax/note/supplierReplyDate；写 PurchaseOrderSalesOrder 中间表；编号走 Task2 引擎；spare 类型单价强制 0、备注默认3‰
- 测试：多订单中间表/双价落库/spare 单/编号新断言/旧断言更新

## Task 5: 采购单列表扩展 + 编辑改单 + 状态流转 + 回签件 + 测试
- GET /api/purchase-orders：toRow +poStatus/poType/orderDate/expectedDeliveryDate/paymentTerms/termsNote/headerName/taxPoint/salesOrders[]
- PATCH /api/purchase-orders/:id：未收货（无 receipts/payments/returnReplenish）才可改，写 PurchaseOrderEditLog
- PATCH /api/purchase-orders/:id/status：poStatus pending→sent→printed→confirmed 单向（采购）
- POST/GET/DELETE /api/purchase-orders/:id/attachments（multipart 复用 uploads 机制）
- 测试：改单历史/锁定/状态流转/附件权限

## Task 6: 两套模板导出 + 预览 + 对拍
- backend/templates/PurchaseOrder-ZRH.xlsx（智锐恒=含税双价）与 PurchaseOrder-JMC.xlsx（锦名诚=不含税）——从历史 xls 提取结构做模板
- backend/src/domain/purchase-doc.ts：buildFromTemplate（编号/抬头/供应商联系方式/明细（用量/采购量/两价/备注）/金额大小写/条款/预计交货/签名）
- GET /api/purchase-orders/:id/export?（content-disposition 下载）、/:id/preview（字段 JSON）
- 对拍：prisma/compare-po-tpl.ts 用真实单数据导出与模板逐格比对（有意差异=填写值）

## Task 7: masters 新字段 + CompanyHeader + 测试
- supplierSchema/partSchema/purchasePartUpdateSchema 加字段（moq/leadTime/safetyStock 归工程、priceInclTax 归采购）
- /api/company-headers CRUD（registerCrud 复用）
- 测试：字段白名单/权限（engineer 不可写 priceInclTax？——priceInclTax 归采购，同 price 口径）

## Task 8: 前端 Masters 扩展（委托实现）
- RESOURCES[1] 供应商 +7 字段；RESOURCES[3] 零件 +moq/leadTime/safetyStock/priceInclTax（激活 CrudTab 568-569）；新增「公司抬头」Tab
- 价格类字段纳入 engineer omit/hide 口径

## Task 9: 前端采购页拆目录（委托实现）
- pages/purchasing/：壳 Tabs（7 页签）+ GeneratePoTab + GeneratePoModal（多订单勾选/双价自动算(taxPoint)/拆单/编号预览）+ PoListTab（新列+操作）+ SparePoModal
- keepAlive 状态提升壳层；保留同步供应商询问/草稿提醒/二次确认

## Task 10: 收尾
- 删除 MaterialCalc 菜单（第二期再并入进销存前，先保留？——不：方案B=改造并入库存页进销存，第二期做；第一期不动 MaterialCalc）
- npm run typecheck + npm test 全绿 + 前端 build + 重启后端（PowerShell Start-Process 方式）+ 前端如缓存提醒 Ctrl+F5
- DEV_HANDOFF.md 追加本期末记录 + commit + push

## 第二期（后续计划，届时细化）：采购跟进/订单采购总览/来料明细/客供料/按机型进销存+MaterialCalc并入删除/共用料视图
## 第三期：供应商/抬头对照表 → 老板核对 → 导入
