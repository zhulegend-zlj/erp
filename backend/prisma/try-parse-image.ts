// 开发工具：用真实客户截图跑 读图+解析 链路（多模态读图实测）
// 用法：npx tsx prisma/try-parse-image.ts "<图片路径>"
import { readOrderImageWithModlens, parseOrderImageText } from '../src/domain/order-image'

async function main() {
  const img = process.argv[2]
  if (!img) {
    console.error('用法：npx tsx prisma/try-parse-image.ts "<图片路径>"')
    process.exit(1)
  }
  console.log('读取图片...（modlens 多模态，约 30-60s）')
  const out = await readOrderImageWithModlens(img)
  if (!out.ok) {
    console.log('识别失败:', out.error)
    process.exit(1)
  }
  console.log('--- 模型原始输出 ---')
  console.log(out.rawText.slice(0, 2000))
  console.log('--- 解析结果 ---')
  const parsed = parseOrderImageText(out.rawText)
  console.log('PO:', parsed.po, ' 行数:', parsed.lines.length)
  for (const l of parsed.lines) {
    console.log(l.sku, '|', l.qty, '|', l.unitPrice, '|', l.needByDate ?? '-')
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
