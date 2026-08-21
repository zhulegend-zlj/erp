# 仓库订单物料计算 / 流水增强 / 物料图片 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让仓库角色按销售订单号查看物料需求与出库差异、按订单号查流水并汇总出库，支持物料图片/规格/供应商。

**Architecture:** Prisma 增加 Part/Product/InventoryLedger 字段；Fastify 增加两个查询接口；React 库存页新增订单物料计算 Tab，基础资料 CRUD 支持新字段，流水 Tab 增强。

**Tech Stack:** Node 24 / TypeScript 5.9 / Fastify 5 / Prisma 6 / PostgreSQL 16 / React 18 / Ant Design 5 / Vitest。

**Spec:** docs/superpowers/specs/2026-08-21-warehouse-materials-ledger-design.md

## Global Constraints

- Node >= 22（当前 24）。
- 端口：后端 3000，前端 5173。
- 测试库 `erp_test`，开发库 `erp`，测试串行执行。
- 中文文案，错误返回 400/404 中文提示。
- 图片先用 URL/路径字段，不做文件上传。

---

### Task 1: Prisma 数据模型与迁移

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_material_fields_and_ledger_order/migration.sql`

**Interfaces:**
- Produces: Prisma Client 类型含 `Part.spec/imageUrl/supplierId`、`Product.imageUrl`、`InventoryLedger.salesOrderId`。

- [ ] **Step 1: 修改 schema**

在 Part 增加：
```prisma
spec       String?
imageUrl   String?
supplier   Supplier? @relation(fields: [supplierId], references: [id])
supplierId Int?
```
Product 增加：
```prisma
imageUrl String?
```
InventoryLedger 增加：
```prisma
salesOrder   SalesOrder? @relation(fields: [salesOrderId], references: [id])
salesOrderId Int?
```
Supplier 反向关系增加 `parts Part[]`。

- [ ] **Step 2: 生成迁移**

Run: `cd backend && npx prisma migrate dev --name material_fields_and_ledger_order`
Expected: 生成 migration.sql 并更新 Prisma Client。

- [ ] **Step 3: 提交**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat: 物料图片/规格/供应商与流水订单号字段"
```

---

### Task 2: applyStockChange 写入订单号

**Files:**
- Modify: `backend/src/domain/inventory.ts`
- Modify: `backend/src/routes/inventory.ts`
- Modify: `backend/src/routes/purchasing.ts`
- Modify: `backend/src/routes/shipping.ts`

**Interfaces:**
- Consumes: `InventoryLedger.salesOrderId` 字段。
- Produces: `applyStockChange(tx, itemType, itemId, delta, refType, refId, salesOrderId?)`。

- [ ] **Step 1: 修改签名并写入 salesOrderId**

```ts
export async function applyStockChange(
  tx: Prisma.TransactionClient,
  itemType: string,
  itemId: number,
  delta: number,
  refType: string,
  refId: number,
  salesOrderId?: number | null
): Promise<number> {
  // ... 库存逻辑不变
  await tx.inventoryLedger.create({ data: { itemType, itemId, delta, balance: next, refType, refId, salesOrderId: salesOrderId ?? null } })
  return next
}
```

- [ ] **Step 2: 更新调用点**

- `inventory.ts` issue：传 `data.salesOrderId`。
- `inventory.ts` production：传 `data.salesOrderId`。
- `shipping.ts` shipment：传 `order.id`。
- `purchasing.ts` receipt：先查 purchaseOrder 的 salesOrderId，再传。

- [ ] **Step 3: 提交**

```bash
git add backend/src/domain/inventory.ts backend/src/routes/inventory.ts backend/src/routes/purchasing.ts backend/src/routes/shipping.ts
git commit -m "feat: 流水记录销售订单号"
```

---

### Task 3: CRUD 支持新字段

**Files:**
- Modify: `backend/src/routes/masters.ts`

**Interfaces:**
- Produces: `POST/PUT /api/parts` 接受 `spec/imageUrl/supplierId`；`POST/PUT /api/products` 接受 `imageUrl`。

- [ ] **Step 1: 扩展 zod schema**

```ts
const productSchema = z.object({
  sku: z.string({ error: 'SKU 必填' }).min(1, 'SKU 必填'),
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  unit: z.string().optional(),
  imageUrl: z.string().optional(),
})

const partSchema = z.object({
  sku: z.string({ error: 'SKU 必填' }).min(1, 'SKU 必填'),
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  unit: z.string().optional(),
  spec: z.string().optional(),
  imageUrl: z.string().optional(),
  supplierId: z.number().int().positive().optional(),
})
```

- [ ] **Step 2: 提交**

```bash
git add backend/src/routes/masters.ts
git commit -m "feat: 基础资料支持物料图片/规格/供应商"
```

---

### Task 4: 订单物料计算接口

**Files:**
- Modify: `backend/src/routes/inventory.ts`
- Test: `backend/src/test/inventory.test.ts`

**Interfaces:**
- Produces: `GET /api/inventory/order-materials?orderNo=<销售订单号>`。

- [ ] **Step 1: 写失败测试**

在 inventory.test.ts 增加：创建成品+BOM+订单+领料，请求接口断言 `requiredQty/issuedQty/variance`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npm test -- src/test/inventory.test.ts`
Expected: FAIL，接口不存在。

- [ ] **Step 3: 实现接口**

逻辑：查 SalesOrder（含 items）→ 收集 productIds → 查 BOM → 汇总 requiredQty → 查该订单 Issue 汇总 issuedQty → 查 Part 信息（含 supplier）→ 返回 items。

- [ ] **Step 4: 跑测试确认通过**

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add backend/src/routes/inventory.ts backend/src/test/inventory.test.ts
git commit -m "feat: 订单物料计算接口"
```

---

### Task 5: 订单流水查询接口

**Files:**
- Modify: `backend/src/routes/inventory.ts`
- Test: `backend/src/test/inventory.test.ts`

**Interfaces:**
- Produces: `GET /api/inventory/order-ledger?orderNo=<销售订单号>`。

- [ ] **Step 1: 写失败测试**

创建订单+领料，请求接口断言 rows 含该订单流水且 totalOutboundQty 正确。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL。

- [ ] **Step 3: 实现接口**

按 `salesOrderId` 查 InventoryLedger，关联 Part/Product 名称，汇总负 delta。

- [ ] **Step 4: 跑测试确认通过**

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add backend/src/routes/inventory.ts backend/src/test/inventory.test.ts
git commit -m "feat: 订单流水查询与出库汇总"
```

---

### Task 6: 基础资料前端新字段

**Files:**
- Modify: `frontend/src/pages/Masters.tsx`

**Interfaces:**
- Consumes: `/api/suppliers`、`/api/parts`、`/api/products`。

- [ ] **Step 1: 扩展字段配置**

零件 fields：sku、name、unit、spec、imageUrl、supplierId；成品 fields：sku、name、unit、imageUrl。

- [ ] **Step 2: 表单按字段类型渲染**

supplierId 用 Select（数据来自 suppliers），imageUrl 用 Input，列表 imageUrl 用 AntD Image 缩略图。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/pages/Masters.tsx
git commit -m "feat: 基础资料支持图片/规格/供应商"
```

---

### Task 7: 库存页订单物料计算 Tab

**Files:**
- Modify: `frontend/src/pages/Inventory.tsx`

**Interfaces:**
- Consumes: `GET /api/orders`、`GET /api/inventory/order-materials`。

- [ ] **Step 1: 新增组件 OrderMaterialsTab**

选择销售订单 → 调接口 → Table 展示：序号、料号+物料名称、图片、供应商、规格、用量、已出库、差值。

- [ ] **Step 2: 挂到 Inventory Tabs**

- [ ] **Step 3: 提交**

```bash
git add frontend/src/pages/Inventory.tsx
git commit -m "feat: 仓库订单物料计算页"
```

---

### Task 8: 流水增强与实时刷新

**Files:**
- Modify: `frontend/src/pages/Inventory.tsx`

**Interfaces:**
- Consumes: `GET /api/inventory/order-ledger`。

- [ ] **Step 1: 流水变动列带符号**

`delta > 0 ? '+' + delta : delta`，入库正数显示 +。

- [ ] **Step 2: 订单号查询与汇总**

LedgerTab 增加订单号选择，调用 order-ledger，显示 totalOutboundQty。

- [ ] **Step 3: 操作后刷新**

Inventory 父组件增加 refreshToken，收货/领料/成品入库成功后 +1；StockTab/LedgerTab 依赖 refreshToken 重新加载。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/Inventory.tsx
git commit -m "feat: 流水订单号查询与实时刷新"
```

---

### Task 9: 全量验证与 FEEDBACK

- [ ] **Step 1: 后端 typecheck + vitest**

Run: `cd backend && npm run typecheck && npm test`
Expected: 全绿。

- [ ] **Step 2: 前端 build**

Run: `cd frontend && npm run build`
Expected: 成功。

- [ ] **Step 3: 更新 FEEDBACK.md 标记已处理并提交**

```bash
git add FEEDBACK.md
git commit -m "docs: 标记本轮反馈已处理"
```

