
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
// 撤回刚才的全量改外购：恢复「无供应商 = 自购；有供应商 = 外购」
const r1 = await p.part.updateMany({ where: { supplierId: null }, data: { sourcing: 'selfbuy' } });
const r2 = await p.part.updateMany({ where: { supplierId: { not: null } }, data: { sourcing: 'purchased' } });
console.log('无供应商→自购:', r1.count, ' 有供应商→外购:', r2.count);
const check = await p.part.groupBy({ by: ['sourcing'], _count: { _all: true } });
for (const g of check) console.log('  当前', g.sourcing, ':', g._count._all, '个');
await p.$disconnect();
