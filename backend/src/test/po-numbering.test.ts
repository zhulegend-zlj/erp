import { describe, expect, it } from 'vitest'
import {
  PO_LETTERS,
  mergeBase,
  nextLetter,
  nextLetterForBase,
  nextSpareNo,
  nextTwoLetterForBase,
  nextTwoLetters,
  parseLetterSuffix,
  parseTwoLetterSuffix,
} from '../domain/po-numbering'

describe('采购单编号引擎（字母口径，老板拍板）', () => {
  it('字母表 A→Z 跳过 I 和 O，共 24 个', () => {
    expect(PO_LETTERS).toHaveLength(24)
    expect(PO_LETTERS).not.toContain('I')
    expect(PO_LETTERS).not.toContain('O')
    expect(PO_LETTERS[0]).toBe('A')
    expect(PO_LETTERS[23]).toBe('Z')
  })

  it('nextLetter 顺序递增且跳过 I/O，末位返回 null（提示手工输入）', () => {
    expect(nextLetter('A')).toBe('B')
    expect(nextLetter('H')).toBe('J') // 跳过 I
    expect(nextLetter('N')).toBe('P') // 跳过 O
    expect(nextLetter('Z')).toBeNull()
    expect(nextLetter('zz')).toBeNull()
  })

  it('nextLetterForBase：订单内 A 起、取现有最大字母+1', () => {
    expect(nextLetterForBase([], '259203')).toBe('A')
    expect(nextLetterForBase(['259203A'], '259203')).toBe('B')
    expect(nextLetterForBase(['259203A', '259203C', '259203B'], '259203')).toBe('D')
    // 其他订单的单号不干扰
    expect(nextLetterForBase(['259278A'], '259203')).toBe('A')
  })

  it('合并单前缀：首PO-末PO 去掉共同前缀（259283/259288 → 259283-288）', () => {
    expect(mergeBase(['259283', '259288'])).toBe('259283-288')
    expect(mergeBase(['262195', '262196'])).toBe('262195-196')
    expect(mergeBase(['243070', '243074'])).toBe('243070-074')
    expect(mergeBase(['269018'])).toBe('269018')
    expect(mergeBase(['261298', '261299', '261300', '261301', '261302', '261303'])).toBe('261298-303')
  })

  it('合并组内字母递增', () => {
    expect(nextLetterForBase(['259283-288E'], '259283-288')).toBe('F')
    expect(nextLetterForBase([], '259283-288')).toBe('A')
  })

  it('parseLetterSuffix 解析单字母后缀', () => {
    expect(parseLetterSuffix('259203A', '259203')).toBe('A')
    expect(parseLetterSuffix('259283-288E', '259283-288')).toBe('E')
    expect(parseLetterSuffix('259278', '259278')).toBeNull() // 无后缀
    expect(parseLetterSuffix('259204A', '259203')).toBeNull() // 前缀不符
  })

  it('自购/现金单：PO-日期-AA 两位字母当天递增', () => {
    expect(nextTwoLetters(null)).toBe('AA')
    expect(nextTwoLetters('AA')).toBe('AB')
    expect(nextTwoLetters('AH')).toBe('AJ') // 跳过 AI
    expect(nextTwoLetters('AN')).toBe('AP') // 跳过 AO
    expect(nextTwoLetters('AZ')).toBe('BA')
    expect(nextTwoLetters('ZZ')).toBeNull()
    const base = 'PO-20260829-'
    expect(nextTwoLetterForBase([], base)).toBe('AA')
    expect(nextTwoLetterForBase(['PO-20260829-AA'], base)).toBe('AB')
    expect(nextTwoLetterForBase(['PO-20260829-AA', 'PO-20260829-AB'], base)).toBe('AC')
    // 别的日期不影响
    expect(nextTwoLetterForBase(['PO-20260828-AA'], base)).toBe('AA')
    expect(parseTwoLetterSuffix('PO-20260829-AB', base)).toBe('AB')
    expect(parseTwoLetterSuffix('PO-20260829-A', base)).toBeNull()
  })

  it('免费备品单：订单号+备品，重复加 -2/-3', () => {
    expect(nextSpareNo([], '259203')).toBe('259203备品')
    expect(nextSpareNo(['259203备品'], '259203')).toBe('259203备品-2')
    expect(nextSpareNo(['259203备品', '259203备品-2'], '259203')).toBe('259203备品-3')
    expect(nextSpareNo([], null)).toBeNull() // 不挂订单：手工填编号
  })
})
