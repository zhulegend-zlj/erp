// 清掉主库测试数据（老板 2026-08-31 要求）：
// TEST 成品/零件/BOM、TEST 客户/供应商、270991/270992 两组测试订单及其采购单。
// 用法：cd backend && npx tsx prisma/clear-test-data.ts（先确认已备份，幂等）
import { prisma } from '../src/db'

const TEST_PO_NOS = ['270991A', '270991B']
const TEST_ORDER_NOS = ['270991', '270992', '270992-1', '270992-2', '270992-3']

await prisma.$transaction(async (tx) => {
  // 1) 测试采购单：先删编辑记录/回签件/订单关联/明细，再删单
  const poIds = (await tx.purchaseOrder.findMany({ where: { orderNo: { in: TEST_PO_NOS } }, select: { id: true } })).map((p) => p.id)
  if (poIds.length > 0) {
    await tx.purchaseOrderEditLog.deleteMany({ where: { purchaseOrderId: { in: poIds } } })
    await tx.purchaseOrderAttachment.deleteMany({ where: { purchaseOrderId: { in: poIds } } })
    await tx.purchaseOrderSalesOrder.deleteMany({ where: { purchaseOrderId: { in: poIds } } })
    await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: { in: poIds } } })
    await tx.purchaseOrder.deleteMany({ where: { id: { in: poIds } } })
  }
  // 2) 测试订单：删明细行再删订单
  const orderIds = (await tx.salesOrder.findMany({ where: { orderNo: { in: TEST_ORDER_NOS } }, select: { id: true } })).map((o) => o.id)
  if (orderIds.length > 0) {
    await tx.salesOrderItem.deleteMany({ where: { orderId: { in: orderIds } } })
    await tx.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
  }
  // 3) TEST 成品/零件与其 BOM（先 BOM 后主体）
  const tProducts = await tx.product.findMany({ where: { sku: { startsWith: 'TEST' } }, select: { id: true } })
  const tParts = await tx.part.findMany({ where: { sku: { startsWith: 'TEST' } }, select: { id: true } })
  const tProductIds = tProducts.map((p) => p.id)
  const tPartIds = tParts.map((p) => p.id)
  if (tProductIds.length > 0 || tPartIds.length > 0) {
    await tx.bom.deleteMany({ where: { OR: [{ productId: { in: tProductIds } }, { partId: { in: tPartIds } }] } })
  }
  if (tProductIds.length > 0) await tx.product.deleteMany({ where: { id: { in: tProductIds } } })
  if (tPartIds.length > 0) await tx.part.deleteMany({ where: { id: { in: tPartIds } } })
  // 4) TEST 客户/供应商
  await tx.customer.deleteMany({ where: { name: { startsWith: 'TEST' } } })
  await tx.supplier.deleteMany({ where: { name: { startsWith: 'TEST' } } })
})

console.log('删除完成，最终状态：')
console.log('成品：' + (await prisma.product.findMany({ select: { sku: true } })).map((p) => p.sku).join('、'))
console.log('零件总数：' + await prisma.part.count())
console.log('订单：' + (await prisma.salesOrder.findMany({ select: { orderNo: true } })).map((o) => o.orderNo).join('、') || '（无）')
console.log('采购单：' + (await prisma.purchaseOrder.findMany({ select: { orderNo: true } })).map((o) => o.orderNo).join('、') || '（无）')
console.log('客户：' + (await prisma.customer.findMany({ select: { name: true } })).map((c) => c.name).join('、'))
console.log('供应商：' + (await prisma.supplier.findMany({ select: { name: true } })).map((s) => s.name).join('、'))
process.exit(0)
