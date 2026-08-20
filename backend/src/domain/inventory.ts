import { Prisma } from '@prisma/client'

export async function applyStockChange(
  tx: Prisma.TransactionClient,
  itemType: string,
  itemId: number,
  delta: number,
  refType: string,
  refId: number
): Promise<number> {
  const stock = await tx.stock.findUnique({ where: { itemType_itemId: { itemType, itemId } } })
  const current = stock?.qtyOnHand ?? 0
  const next = current + delta
  if (next < 0) throw new Error('库存不足')
  await tx.stock.upsert({
    where: { itemType_itemId: { itemType, itemId } },
    update: { qtyOnHand: next },
    create: { itemType, itemId, qtyOnHand: next }
  })
  await tx.inventoryLedger.create({ data: { itemType, itemId, delta, balance: next, refType, refId } })
  return next
}
