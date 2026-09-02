import { describe, expect, it } from 'vitest'

import { toErrorMessage } from '../../src/shared/errors.js'

describe('toErrorMessage', () => {
  it('preserves Error messages', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error values', () => {
    expect(toErrorMessage('failed')).toBe('failed')
    expect(toErrorMessage(null)).toBe('null')
  })
})
