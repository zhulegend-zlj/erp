
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const envTxt = fs.readFileSync('D:/AI/erp/backend/.env', 'utf8');
const url = envTxt.match(/^DATABASE_URL=([^\r\n]+)/m)![1];
const stamp = new Date().toISOString().slice(0,19).replace(/[-:T]/g,'');
const backupPath = 'D:/AI/erp-backups/erp-before-v3-sups-' + stamp + '.dump';
const bk = spawnSync('C:/Program Files/PostgreSQL/16/bin/pg_dump.exe', ['-Fc','-d',url,'-f',backupPath], { encoding: 'utf8' });
if (bk.status !== 0) { console.error('备份失败', bk.stderr); process.exit(1); }
console.log('backup ok:', backupPath);

const p = new PrismaClient();
// V3 供应商（按老板已录 3 家的口径：名称=对公正式全称、简称、联系人/电话/传真/邮箱取采购单、付款方式、默认抬头智锐恒、税点按税点图）
const LIST: { shortName: string; name: string; contact: string | null; phone: string | null; fax: string | null; email: string | null; payment: string; tax: number | null }[] = [
  { shortName: '铭亚', name: '东莞市谢岗铭亚精密五金厂', contact: '刘生', phone: '0769-87185686', fax: '0769-87185686', email: 'business@jmc-metal.com', payment: '月结', tax: 1 },
  { shortName: '盈黔', name: '东莞盈黔橡塑制品有限公司', contact: '王先生', phone: '13728253593', fax: '0769-87707179', email: 'china094@126.com', payment: '月结', tax: 13 },
  { shortName: '冠界', name: '东莞市冠界精密五金制品有限公司', contact: '叶生', phone: '0769-87187030', fax: '0769-82252870', email: null, payment: '月结', tax: 10 },
  { shortName: '新玉盛', name: '东莞市樟木头新玉盛五金厂', contact: '全总', phone: '13929488216', fax: null, email: null, payment: '月结', tax: 1 },
  { shortName: '金爱', name: '横沥金爱五金加工店', contact: '吴先生', phone: '13642937613', fax: null, email: null, payment: '月结', tax: 3 },
  { shortName: '伟胜', name: '伟胜模具塑胶制品厂', contact: '王先生', phone: '13609676819', fax: '0769-82773588', email: null, payment: '月结', tax: 1 },
  { shortName: '粤徽', name: '东莞市粤徽磁铁制品有限公司', contact: '何先生', phone: null, fax: '0769-86935376', email: 'business@jmc-metal.com', payment: '月结', tax: 10 },
  { shortName: '玖丰', name: '玖丰', contact: '王总', phone: '0769-87187030', fax: null, email: '1274068873@qq.com', payment: '月结', tax: 10 },
  { shortName: '林洲', name: '林洲电子科技有限公司', contact: '张林平', phone: '13538681686', fax: '0769-81172391', email: null, payment: '月结', tax: 7 },
  { shortName: '金邦', name: '金邦塑胶五金制品有限公司', contact: '尹先生', phone: '15814266168', fax: null, email: null, payment: '月结', tax: 10 },
  { shortName: '盛旺', name: '东莞市大朗盛旺五金制品厂', contact: '向先生', phone: '13926851295', fax: null, email: null, payment: '月结', tax: 10 },
  { shortName: '鑫圆', name: '东莞市樟木头鑫圆包装制品加工厂', contact: '韩先生', phone: '18029055161', fax: null, email: null, payment: '月结', tax: 1 },
  { shortName: '彩智翔', name: '彩智翔包装制品有限公司', contact: '李小姐', phone: '13711951119', fax: '0769-82607832', email: 'xinhua2009@vip.163.com', payment: '月结', tax: null }, // 税点图没有这家
  { shortName: '奕程', name: '东莞市奕程电子科技有限公司', contact: '周先生', phone: '13500065632', fax: null, email: 'business@jmc-metal.com', payment: '月结30天', tax: 9 },
  { shortName: '雄浩', name: '雄浩包装制品有限公司', contact: '甘先生', phone: '13392306357', fax: null, email: 'business@jmc-metal.com', payment: '月结30天', tax: 7 },
  { shortName: '智宝', name: '东莞市智宝包装材料有限公司', contact: '姚先生', phone: '13712028751', fax: null, email: null, payment: '月结', tax: 13 },
];
let created = 0;
for (const s of LIST) {
  const exist = await p.supplier.findFirst({ where: { shortName: s.shortName } });
  if (exist) { console.log('跳过(已存在):', s.shortName); continue; }
  await p.supplier.create({
    data: {
      name: s.name, shortName: s.shortName, contact: s.contact, phone: s.phone, fax: s.fax, email: s.email,
      defaultPaymentTerms: s.payment, defaultHeaderName: '东莞市智锐恒电子有限公司', taxPoint: s.tax,
    },
  });
  created++;
}
console.log('新录入:', created);
const all = await p.supplier.findMany({ orderBy: { id: 'asc' } });
console.log('--- 当前供应商共', all.length, '家 ---');
for (const s of all) console.log(s.shortName + '\t' + s.name + '\t税点' + (s.taxPoint == null ? '无' : Number(s.taxPoint) + '%') + '\t' + (s.contact ?? '') + '\t' + (s.phone ?? ''));
await p.$disconnect();
