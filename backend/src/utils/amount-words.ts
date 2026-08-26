// 英文大写金额（发票 SAY TOTAL 用），口径照微信模板：
// 72010.08 → SEVENTY-TWO THOUSAND AND TEN CENTS EIGHT
// 1431192.32 → ONE MILLION FOUR HUNDRED THIRTY-ONE THOUSAND ONE HUNDRED AND NINETY-TWO CENTS THIRTY-TWO

const ONES = [
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
] as const
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'] as const

function below100(n: number): string {
  if (n < 20) return ONES[n] ?? ''
  const t = TENS[Math.floor(n / 10)] ?? ''
  const o = n % 10
  return o === 0 ? t : t + '-' + (ONES[o] ?? '')
}

// 末组（个位组）按英式加 AND（ONE HUNDRED AND NINETY-TWO）；更高组不加（FOUR HUNDRED THIRTY-ONE THOUSAND）
function below1000(n: number, withAnd: boolean): string {
  const h = Math.floor(n / 100)
  const rest = n % 100
  if (h === 0) return below100(rest)
  if (rest === 0) return (ONES[h] ?? '') + ' HUNDRED'
  return (ONES[h] ?? '') + ' HUNDRED' + (withAnd ? ' AND ' : ' ') + below100(rest)
}

/** 非负整数转英文（英式 AND 规则：末组 <100 且前面有更高组时加 AND） */
export function intToWords(n: number): string {
  const v = Math.floor(n)
  if (v === 0) return 'ZERO'
  const groups: { v: number; name: string }[] = []
  const names = ['', 'THOUSAND', 'MILLION', 'BILLION']
  let rest = v
  let gi = 0
  while (rest > 0 && gi < names.length) {
    groups.push({ v: rest % 1000, name: names[gi] ?? '' })
    rest = Math.floor(rest / 1000)
    gi++
  }
  const parts: string[] = []
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!
    if (g.v === 0) continue
    let seg = below1000(g.v, i === 0)
    if (g.name) seg += ' ' + g.name
    if (i === 0 && g.v < 100 && parts.length > 0) seg = 'AND ' + seg
    parts.push(seg)
  }
  return parts.join(' ')
}

/** 金额转英文大写：整数部分 + ' CENTS <角分>'（角分按数字读音，如 8→EIGHT、32→THIRTY-TWO） */
export function amountInWords(value: number | string | unknown): string {
  const n = typeof value === 'number' ? value : Number(String(value ?? ''))
  if (!Number.isFinite(n)) return 'ZERO'
  const whole = Math.floor(Math.abs(n))
  const cents = Math.round((Math.abs(n) - whole) * 100)
  const w = intToWords(whole)
  if (cents === 0) return w
  return w + ' CENTS ' + intToWords(cents)
}

/** 箱数大写（装箱单 SAY TOTAL ... CARTONS ONLY） */
export function cartonsInWords(n: number): string {
  return intToWords(Math.floor(n))
}
