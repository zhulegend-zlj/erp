
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const envTxt = fs.readFileSync('D:/AI/erp/backend/.env', 'utf8');
const m = envTxt.match(/^DATABASE_URL=([^\r\n]+)/m);
const url = m![1];
const stamp = new Date().toISOString().slice(0,19).replace(/[-:T]/g,'');
const backupPath = 'D:/AI/erp-backups/erp-before-clear-sup-price-' + stamp + '.dump';
const bk = spawnSync('C:/Program Files/PostgreSQL/16/bin/pg_dump.exe', ['-Fc','-d',url,'-f',backupPath], { encoding: 'utf8' });
if (bk.status !== 0) { console.error('备份失败', bk.stderr); process.exit(1); }
console.log('backup ok:', backupPath);

const p = new PrismaClient();
await p.$transaction(async (tx) => {
  const b = await tx.priceBundle.findFirst({ include: { items: true } });
  if (b) {
    await tx.priceBundle.delete({ where: { id: b.id } }); // items 级联删，成员零件 priceBundleId 置空
    console.log('已删套餐:', b.name, '成员', b.items.length, '个');
  }
  const pr = await tx.part.updateMany({ data: { price: null, priceInclTax: null } });
  console.log('价格已清空零件数:', pr.count);
  const sd = await tx.supplier.deleteMany({});
  console.log('供应商已删:', sd.count);
});
const sup = await p.supplier.count();
const partSup = await p.part.count({ where: { supplierId: { not: null } } });
const partPrice = await p.part.count({ where: { OR: [{ price: { not: null } }, { priceInclTax: { not: null } }] } });
console.log('--- 校验 ---');
console.log('供应商剩余:', sup, ' 零件挂供应商:', partSup, ' 有价格零件:', partPrice);
await p.$disconnect();
