import { describe, expect, it } from 'vitest'

import { parseWechat4HelperResponse } from '../../src/main/sources/wechat4/helper-protocol.js'

describe('WeChat 4 helper protocol', () => {
  it('accepts a versioned success response', () => {
    expect(
      parseWechat4HelperResponse(
        JSON.stringify({ v: 1, id: 'request-1', ok: true, result: { verified: true } }),
      ),
    ).toEqual({ v: 1, id: 'request-1', ok: true, result: { verified: true } })
  })

  it('accepts only known structured error codes', () => {
    expect(
      parseWechat4HelperResponse(
        JSON.stringify({
          v: 1,
          id: 'request-2',
          ok: false,
          error: { code: 'KEY_VALIDATION_FAILED', message: 'fixed message', retryable: false },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'KEY_VALIDATION_FAILED' } })

    expect(() =>
      parseWechat4HelperResponse(
        JSON.stringify({
          v: 1,
          id: 'request-3',
          ok: false,
          error: { code: 'RAW_NATIVE_ERROR', message: '/private/path', retryable: false },
        }),
      ),
    ).toThrow(/invalid error/i)
  })

  it('rejects invalid JSON, versions and oversized lines', () => {
    expect(() => parseWechat4HelperResponse('{')).toThrow(/invalid JSON/i)
    expect(() =>
      parseWechat4HelperResponse(JSON.stringify({ v: 2, id: 'request', ok: true, result: {} })),
    ).toThrow(/envelope/i)
    expect(() => parseWechat4HelperResponse('x'.repeat(64 * 1024 + 1))).toThrow(/limit/i)
  })
})
