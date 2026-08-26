// 公司资料补全（数据来源：ZRH20260814006 Official Invoice / EU ZRHS20260814002 商业发票模板）
// 幂等：已有配置则更新为模板值。
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const PROFILE = {
  name: 'Dongguan Zhiruiheng Electronic Co., Ltd',
  address: 'Room 201, No.239 Changhuang Road, Changping Town, Dongguan Guangdong Province 528536 China',
  contact: 'bl@jmc-metal.com',
  email: 'BUSINESS@JMC-METAL.COM',
  vatNo: '91441900MAG11BDD14',
  taxRate: '0',
  bankName: 'CHINA MERCHANTS BANK DONGGUAN CHANGPING SUB-BRANCH',
  bankPhone: '+86 0769-81089991',
  bankAddress: 'Room 101, Jun Hong Plaza, 19 Changping Avenue, Changping Town, Dongguan, Guangdong Province, China',
  swift: 'CMBCCNBS195',
  accountName: 'Dongguan Zhiruiheng Electronic Co., Ltd',
  accountNo: '769914313710066',
}

async function main() {
  const existing = await prisma.companyProfile.findFirst()
  if (existing) {
    await prisma.companyProfile.update({ where: { id: existing.id }, data: PROFILE })
    console.log('公司资料已更新（原 id', existing.id, '）')
  } else {
    await prisma.companyProfile.create({ data: PROFILE })
    console.log('公司资料已创建')
  }
  const p = await prisma.companyProfile.findFirst()
  console.log('当前配置：')
  for (const [k, v] of Object.entries(PROFILE)) console.log(' ', k + ':', v)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
