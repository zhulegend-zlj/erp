/**
 * 采购单编号引擎（2026-08-29 采购重构，老板拍板口径）：
 * - 正常单（挂 1 个订单）：<订单号><字母>，订单内 A→Z 跳 I/O 递增，如 259203A
 * - 合并单（挂多个订单）：<首PO>-<末PO><字母>（去掉首末共同前缀），如 259283-288E，合并组内递增
 * - 拆单（同物料分批）：同一订单/合并组内字母顺延
 * - 免费备品单：<订单号>备品（重复加 -2/-3）；不挂订单的手工填编号
 * - 自购/现金（无订单）：PO-YYYYMMDD-AA/AB/AC…（当天递增，两位字母组合跳 I/O）
 * 全部编号可手工改（唯一性校验在调用方做）。
 */

// A→Z 跳过 I 与 O（共 24 个字母，老板拍板）
export const PO_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('')

/** 字母序号 → 字母；越界返回 null（提示手工输入） */
export function letterAt(index: number): string | null {
  return index >= 0 && index < PO_LETTERS.length ? PO_LETTERS[index] ?? null : null
}

/** 给定字母，返回下一个字母；最后一个返回 null */
export function nextLetter(current: string): string | null {
  const idx = PO_LETTERS.indexOf(current.toUpperCase())
  if (idx < 0) return null
  return letterAt(idx + 1)
}

/** 两位字母组合（AA→AB→…→AZ→BA→…）的下一个；无当前返回 'AA'；超出返回 null */
export function nextTwoLetters(current: string | null): string | null {
  if (current === null || current === '') return PO_LETTERS[0]! + PO_LETTERS[0]!
  const a = current.charAt(0)
  const b = current.charAt(1)
  const bi = PO_LETTERS.indexOf(b)
  if (bi >= 0 && bi < PO_LETTERS.length - 1) return a + PO_LETTERS[bi + 1]!
  const ai = PO_LETTERS.indexOf(a)
  if (ai < PO_LETTERS.length - 1) return PO_LETTERS[ai + 1]! + PO_LETTERS[0]!
  return null
}

/**
 * 从已有单号列表里解析当前字母（单字母后缀，如 259203A → A；259283-288E → E）。
 * 要求单号以 base 开头且剩余部分是 1 个字母或 1 个字母 + 备品/拆单后缀。
 */
export function parseLetterSuffix(orderNo: string, base: string): string | null {
  if (!orderNo.startsWith(base)) return null
  const rest = orderNo.slice(base.length)
  if (rest.length === 0) return null
  const ch = rest.charAt(0).toUpperCase()
  if (!PO_LETTERS.includes(ch)) return null
  return ch
}

/** 解析当天两位字母序号（PO-YYYYMMDD-AA 的 AA 部分）；不匹配返回 null */
export function parseTwoLetterSuffix(orderNo: string, base: string): string | null {
  if (!orderNo.startsWith(base)) return null
  const rest = orderNo.slice(base.length)
  if (rest.length !== 2) return null
  const a = rest.charAt(0).toUpperCase()
  const b = rest.charAt(1).toUpperCase()
  if (!PO_LETTERS.includes(a) || !PO_LETTERS.includes(b)) return null
  return a + b
}

/** 合并单前缀：首PO-末PO，末 PO 取后 3 位（历史 Excel 口径：259283/259288 → 259283-288；243070/243074 → 243070-074） */
export function mergeBase(orderNos: string[]): string {
  const sorted = [...orderNos].sort()
  const first = sorted[0] ?? ''
  const last = sorted[sorted.length - 1] ?? ''
  if (first === last) return first
  return first + '-' + last.slice(-3)
}

/**
 * 从一组已有单号中取「base+单字母」的最大字母，返回下一个字母；
 * 没有任何以 base 开头的字母单 → 返回 A；已用到最后一个字母 → 返回 null（需手工输入）。
 */
export function nextLetterForBase(existingOrderNos: string[], base: string): string | null {
  let maxIdx = -1
  for (const no of existingOrderNos) {
    const ch = parseLetterSuffix(no, base)
    if (ch) maxIdx = Math.max(maxIdx, PO_LETTERS.indexOf(ch))
  }
  return letterAt(maxIdx + 1)
}

/** 当天两位字母序号的下一个（existing 中取以 base 开头的两位后缀最大值） */
export function nextTwoLetterForBase(existingOrderNos: string[], base: string): string | null {
  let max: string | null = null
  for (const no of existingOrderNos) {
    const two = parseTwoLetterSuffix(no, base)
    if (!two) continue
    if (max === null) max = two
    else {
      const a = PO_LETTERS.indexOf(two.charAt(0)) * PO_LETTERS.length + PO_LETTERS.indexOf(two.charAt(1))
      const b = PO_LETTERS.indexOf(max.charAt(0)) * PO_LETTERS.length + PO_LETTERS.indexOf(max.charAt(1))
      if (a > b) max = two
    }
  }
  return nextTwoLetters(max)
}

/** 备品单号：<订单号>备品，已存在则 -2/-3… 递增 */
export function nextSpareNo(existingOrderNos: string[], linkedOrderNo: string | null): string | null {
  if (!linkedOrderNo) return null // 不挂订单的备品单：手工填编号
  const base = linkedOrderNo + '备品'
  if (!existingOrderNos.includes(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = base + '-' + n
    if (!existingOrderNos.includes(candidate)) return candidate
  }
  return null
}
