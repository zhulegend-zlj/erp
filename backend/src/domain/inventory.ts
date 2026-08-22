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
  // 读-改-写丢失更新 / 超卖。
  // INSERT 分支防护：无库存行且 delta<0（如从未收货直接领料）时 SELECT 无行 →
  // 不插入任何负数余额，返回空行 → 库存不足；已有库存行时 EXISTS 保证走
  // ON CONFLICT 的 UPDATE（同样带非负护栏），不因 INSERT 失效。
  const rows = await tx.$queryRaw<{ balance: number | bigint }[]>`
    INSERT INTO "Stock" ("itemType", "itemId", "qtyOnHand")
    SELECT ${itemType}, ${itemId}, ${delta}
    WHERE ${delta} >= 0 OR EXISTS (
      SELECT 1 FROM "Stock" s WHERE s."itemType" = ${itemType} AND s."itemId" = ${itemId}
    )
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
