import { Prisma } from '@prisma/client'

export async function applyStockChange(
  tx: Prisma.TransactionClient,
  itemType: string,
  itemId: number,
  delta: number,
  refType: string,
  refId: number,
  salesOrderId?: number | null
): Promise<number> {
  // 原子增减：INSERT ... ON CONFLICT DO UPDATE，带余额非负条件，避免并发下的
  // 读-改-写丢失更新 / 超卖。UPDATE 未命中（余额将变负）则返回空行 → 库存不足。
  const rows = await tx.$queryRaw<{ balance: number | bigint }[]>`
    INSERT INTO "Stock" ("itemType", "itemId", "qtyOnHand")
    VALUES (${itemType}, ${itemId}, ${delta})
    ON CONFLICT ("itemType", "itemId")
    DO UPDATE SET "qtyOnHand" = "Stock"."qtyOnHand" + ${delta}
    WHERE "Stock"."qtyOnHand" + ${delta} >= 0
    RETURNING "qtyOnHand" AS balance
  `
  if (rows.length === 0) throw new Error('库存不足')
  const next = Number(rows[0]!.balance)
  await tx.inventoryLedger.create({
    data: { itemType, itemId, delta, balance: next, refType, refId, salesOrderId: salesOrderId ?? null }
  })
  return next
}
