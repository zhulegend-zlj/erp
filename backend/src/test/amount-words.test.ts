import { describe, it, expect } from 'vitest'
import { amountInWords, cartonsInWords } from '../utils/amount-words'

describe('amount-words（英文大写金额）', () => {
  it('整数与带角分金额的英文大写', () => {
    expect(amountInWords('72010.08')).toBe('SEVENTY-TWO THOUSAND AND TEN CENTS EIGHT')
    expect(amountInWords('1431192.32')).toBe(
      'ONE MILLION FOUR HUNDRED THIRTY-ONE THOUSAND ONE HUNDRED AND NINETY-TWO CENTS THIRTY-TWO',
    )
    expect(amountInWords('0.05')).toBe('ZERO CENTS FIVE')
    expect(amountInWords('100')).toBe('ONE HUNDRED')
    expect(amountInWords('1010')).toBe('ONE THOUSAND AND TEN')
    expect(amountInWords('1100')).toBe('ONE THOUSAND ONE HUNDRED')
    expect(amountInWords('0')).toBe('ZERO')
  })

  it('箱数大写', () => {
    expect(cartonsInWords(1414)).toBe('ONE THOUSAND FOUR HUNDRED AND FOURTEEN')
    expect(cartonsInWords(1)).toBe('ONE')
  })
})
