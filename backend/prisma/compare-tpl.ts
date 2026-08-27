import { buildFromTemplate } from '../src/domain/shipment-docs-template'
import type { ShipmentDocData, DocLine } from '../src/domain/shipment-docs'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import XLSX from 'xlsx'

const company = {
  name: 'Dongguan Zhiruiheng Electronic Co., Ltd',
  address: 'Room 201, No.239 Changhuang Road,\nChangping Town,Dongguan\nGuangdong Province ,528536 China',
  contact: 'bl@jmc-metal.com',
  email: 'BUSINESS@JMC-METAL.COM',
  vatNo: '91441900MAG11BDD14',
  taxRate: '0',
  bankName: 'CHINA MERCHANTS BANK DONGGUAN CHANGPING SUB-BRANCH',
  bankPhone: '+86 0769-81089991',
  bankAddress: 'Room 101, Jun Hong Plaza, 19 Changping Avenue, Changping Town, Dongguan,Guangdong Province, China',
  swift: 'CMBCCNBS195',
  accountName: 'Dongguan Zhiruiheng Electronic Co., Ltd',
  accountNo: '769914313710066',
}

const line = (sku: string, nameEn: string, po: string, qty: number, price: number, lot: string, extra: Partial<DocLine> = {}): DocLine => ({
  product: { sku, name: 'x', nameEn, hsCode: null },
  qty, unitPrice: String(price), customerPoNo: po, lineNo: null, lotNo: lot,
  cartons: null, netWeight: null, grossWeight: null, cbm: null,
  containerNo: null, sealNo: null, hblNo: null, remark: null, ...extra,
})

// ============ 收款发票：完全复刻原表数据 ============
const official: ShipmentDocData = {
  company,
  customer: {
    name: 'Corsair Memory, Inc.',
    country: 'United States',
    contact: 'Phone: (510) 657-8747',
    address: '115 N. McCarthy Blvd.\nMilpitas, CA, 95035\nUnited States',
    vatNo: null, eori: null,
    notifyParty: '',
  },
  orderNo: 'SO-1',
  shipment: {
    invoiceNo: 'ZRH20260814006', paymentTerms: 'NET 60', incoterm: 'FCA', mark: null,
    origin: null, hsCode: null, taxRate: '0', vesselVoyage: null,
    etd: null, eta: null, shippingInstructions: 'ALU 1264 pcs',
    shippedAt: new Date('2026-08-14'),
  },
  lines: [
    line('CSP_V3_BPK', 'CLUBSPORT PEDALS V3 BRAKE PERFORMANCE KIT', '269776', 1264, 56.97, null, { remark: '100% payment', lineNo: '2.1' }),
  ],
  payments: [],
}

// ============ EU 商业发票/装箱单：完全复刻原表数据 ============
const euCustomer = {
  name: 'CORSAIR COMPONENTS LTD',
  country: 'UNITED KINGDOM',
  contact: 'Sasha Amoateng <sasha.amoateng@corsair.com>',
  address: '1020 ESKDALE ROAD WINNERSH TRIANGLE，WOKINGHAM,RG41 5TS GB',
  vatNo: 'NL827571732B01', eori: 'NL827571732',
  notifyParty: 'Corsair Components, Ltd - BEM\nATTN: RECEIVING\nC/O Corsair Memory BV\nDHL Supply Chain Bemmel\nNijverheidstraat 51a\nBemmel, 6681 LN，Netherlands\nContact: Sasha Amoateng <sasha.amoateng@corsair.com>',
}
const euCommercial: ShipmentDocData = {
  company,
  customer: euCustomer,
  orderNo: 'SO-2',
  shipment: {
    invoiceNo: 'ZRHS20260814002', paymentTerms: null, incoterm: 'FCA', mark: 'FANATEC',
    origin: 'China', hsCode: '9504 50 0000', taxRate: null,
    vesselVoyage: 'CMA CGM ZHENG HE / 0FMMMW1MA',
    etd: new Date('2026-08-18'), eta: new Date('2026-09-23'), shippingInstructions: null,
    shippedAt: new Date('2026-08-14'),
  },
  lines: [
    line('CSP_V3', 'CLUBSPORT PEDALE V3', '268180', 270, 992.98, 'ABO4D6305', { cartons: 270, netWeight: '1657.8', grossWeight: '2143.8', cbm: '14.04', containerNo: 'CMAU4943970', sealNo: 'J2559942', hblNo: 'SZXS010223' }),
    line('CSP_V3', 'CLUBSPORT PEDALE V3', '269019', 788, 992.98, 'ABO4D6321', { cartons: 788, netWeight: '4838.32', grossWeight: '6256.72', cbm: '40.976', containerNo: 'TXGU6822380', sealNo: 'M5871814', hblNo: 'SZX31198544' }),
    line('CRD-9040002-WW', 'CLUBSPORT SHIFTER SQ V 1.5 WITH USB ADAPTER', '268817', 180, 519.66, 'AD14D6301', { cartons: 180, netWeight: '455.4', grossWeight: '576', cbm: '2.88', containerNo: 'TXGU6822380', sealNo: 'M5871814', hblNo: 'SZX31198544' }),
    line('CSP_V3I', 'CLUBSPORT PEDALE V3 INVERTIERT', '269019', 150, 1404.32, 'ABO7D6331', { cartons: 150, netWeight: '1344', grossWeight: '1722', cbm: '10.2', containerNo: 'TXGU6822380', sealNo: 'M5871814', hblNo: 'SZX31198544' }),
    line('CSP_V3_BPK', 'CLUBSPORT PEDALS V3 BRAKE PERFORMANCE KIT', '269776', 1264, 56.97, 'ABO5D6341', { cartons: 22, netWeight: '44.24', grossWeight: '255.16', cbm: '1.527552', containerNo: 'SELU4535980', sealNo: 'M4492285', hblNo: 'SZX31192884' }),
    line('SP-CSP_V3_LOADCELL', 'CSP V3 LOAD CELL', '269959', 150, 28.94, 'ADOED6333', { cartons: 3, netWeight: '17.76', grossWeight: '18', cbm: '0.03' }),
    line('SP-RJ12_RJ12-120', 'RJ12 TO RJ12 CABLE - 120 CM', '269959', 20, 4.08, 'ADQID6336', { cartons: 1, netWeight: '0.66', grossWeight: '0.74', cbm: '0.01' }),
  ],
  payments: [],
}

const cmp = (origFile: string, newFile: string, sheetName: string) => {
  const w1 = XLSX.readFile(origFile, { cellStyles: true, cellFormula: true })
  const w2 = XLSX.readFile(newFile, { cellStyles: true, cellFormula: true })
  const s1 = w1.Sheets[sheetName]
  const s2 = w2.Sheets[sheetName]
  if (!s1 || !s2) { console.log(sheetName, ': sheet missing', !!s1, !!s2); return }
  const r1 = XLSX.utils.decode_range(s1['!ref']!)
  const r2 = XLSX.utils.decode_range(s2['!ref']!)
  const maxR = Math.max(r1.e.r, r2.e.r)
  const maxC = Math.max(r1.e.c, r2.e.c)
  const diffs: string[] = []
  for (let r = 0; r <= maxR; r++) {
    for (let c = 0; c <= maxC; c++) {
      const a = XLSX.utils.encode_cell({ r, c })
      const c1 = s1[a]
      const c2 = s2[a]
      const v1 = c1 ? c1.v : undefined
      const v2 = c2 ? c2.v : undefined
      const f1 = c1?.f ?? undefined
      const f2 = c2?.f ?? undefined
      const z1 = c1?.z ? String(c1.z).replace(/\\/g, '') : undefined
      const z2 = c2?.z ? String(c2.z).replace(/\\/g, '') : undefined
      const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)
      if (String(norm(v1)) !== String(norm(v2)) || String(f1 ?? '') !== String(f2 ?? '') || String(z1 ?? '') !== String(z2 ?? '')) {
        if (v1 === undefined && v2 === undefined) continue
        diffs.push(a + ' | 原: ' + JSON.stringify({ v: norm(v1), f: f1, z: z1 }).slice(0, 90) + ' | 新: ' + JSON.stringify({ v: norm(v2), f: f2, z: z2 }).slice(0, 90))
      }
    }
  }
  const m1 = (s1['!merges'] ?? []).map((m: { s: { r: number; c: number }, e: { r: number; c: number } }) => XLSX.utils.encode_cell(m.s) + ':' + XLSX.utils.encode_cell(m.e)).sort()
  const m2 = (s2['!merges'] ?? []).map((m: { s: { r: number; c: number }, e: { r: number; c: number } }) => XLSX.utils.encode_cell(m.s) + ':' + XLSX.utils.encode_cell(m.e)).sort()
  if (String(m1) !== String(m2)) console.log('  MERGES 差异:', m1.length, 'vs', m2.length)
  console.log('==== ' + sheetName + ': ' + diffs.length + ' 处差异 ====')
  for (const d of diffs.slice(0, 60)) console.log(' ', d)
}

async function main() {
  const outDir = 'C:/Windows/Temp/tpl-cmp'
  const mk = (await import('node:fs')).mkdirSync
  mk(outDir, { recursive: true })
  const off = await buildFromTemplate('official', official)
  writeFileSync(resolve(outDir, 'official.xlsx'), off!)
  cmp('templates/OfficialInvoice.xlsx', resolve(outDir, 'official.xlsx'), 'Sheet1')

  const com = await buildFromTemplate('commercial', euCommercial)
  writeFileSync(resolve(outDir, 'commercial.xlsx'), com!)
  cmp('templates/EU-CommercialInvoice-PackingList.xlsx', resolve(outDir, 'commercial.xlsx'), 'Commercial invoice')

  const euPacking: ShipmentDocData = {
    ...euCommercial,
    lines: [
      line('CSP_V3', 'CLUBSPORT PEDALE V3', '268180', 270, 992.98, 'ABO4D6305', { cartons: 270, netWeight: '1657.8', grossWeight: '2143.8', cbm: '14.04', containerNo: 'CMAU4943970', sealNo: 'J2559942', hblNo: 'SZXS010223' }),
      line('CSP_V3', 'CLUBSPORT PEDALE V3', '269019', 788, 992.98, 'ABO4D6321', { cartons: 788, netWeight: '4838.32', grossWeight: '6256.72', cbm: '40.976', containerNo: 'TXGU6822380', sealNo: 'M5871814', hblNo: 'SZX31198544' }),
      line('CRD-9040002-WW', 'CLUBSPORT SHIFTER SQ V 1.5 WITH USB ADAPTER', '268817', 180, 519.66, 'AD14D6301', { cartons: 180, netWeight: '455.4', grossWeight: '576', cbm: '2.88', containerNo: 'TXGU6822380', sealNo: 'M5871814', hblNo: 'SZX31198544' }),
      line('CSP_V3I', 'CLUBSPORT PEDALE V3 INVERTIERT', '269019', 150, 1404.32, 'ABO7D6331', { cartons: 150, netWeight: '1344', grossWeight: '1722', cbm: '10.2', containerNo: 'TXGU6822380', sealNo: 'M5871814', hblNo: 'SZX31198544' }),
      line('CSP_V3_BPK', 'CLUBSPORT PEDALS V3 BRAKE PERFORMANCE KIT', '269776', 1260, 56.97, 'ABO5D6341', { cartons: 21, netWeight: '44.1', grossWeight: '254.94', cbm: '1.512', containerNo: 'SELU4535980', sealNo: 'M4492285', hblNo: 'SZX31192884' }),
      line('CSP_V3_BPK', 'CLUBSPORT PEDALS V3 BRAKE PERFORMANCE KIT', '269776', 4, 56.97, 'ABO5D6341', { cartons: 1, netWeight: '0.14', grossWeight: '0.22', cbm: '0.015552', containerNo: 'SELU4535980', sealNo: 'M4492285', hblNo: 'SZX31192884' }),
      line('SP-CSP_V3_LOADCELL', 'CSP V3 LOAD CELL', '269959', 150, 28.94, 'ADOED6333', { cartons: 3, netWeight: '17.76', grossWeight: '18', cbm: '0.03' }),
      line('SP-RJ12_RJ12-120', 'RJ12 TO RJ12 CABLE - 120 CM', '269959', 20, 4.08, 'ADQID6336', { cartons: 1, netWeight: '0.66', grossWeight: '0.74', cbm: '0.01' }),
    ],
  }
  const pck = await buildFromTemplate('packing', euPacking)
  writeFileSync(resolve(outDir, 'packing.xlsx'), pck!)
  cmp('templates/EU-CommercialInvoice-PackingList.xlsx', resolve(outDir, 'packing.xlsx'), 'Packing list')
}
main()
