export const WECHAT4_HELPER_PROTOCOL_VERSION = 1 as const
export const WECHAT4_HELPER_MAX_LINE_BYTES = 64 * 1024

export type Wechat4HelperMethod =
  | 'probe'
  | 'selfTest'
  | 'validateKey'
  | 'validateCandidateFd'
  | 'schemaOverviewFd'
  | 'personalEmoticonsFd'
  | 'storeEmoticonsFd'
  | 'acquireKey'

export type Wechat4HelperErrorCode =
  | 'PERMISSION_DENIED'
  | 'DATABASE_NOT_FOUND'
  | 'SNAPSHOT_CHANGED'
  | 'KEY_FORMAT_INVALID'
  | 'KEY_ACQUISITION_FAILED'
  | 'KEY_VALIDATION_FAILED'
  | 'UNSUPPORTED_WECHAT_VERSION'
  | 'INVALID_REQUEST'
  | 'INTERNAL'

export interface Wechat4HelperRequest {
  v: typeof WECHAT4_HELPER_PROTOCOL_VERSION
  id: string
  method: Wechat4HelperMethod
  params?: Record<string, string>
}

export type Wechat4HelperResponse =
  | {
      v: typeof WECHAT4_HELPER_PROTOCOL_VERSION
      id: string
      ok: true
      result: Record<string, unknown>
    }
  | {
      v: typeof WECHAT4_HELPER_PROTOCOL_VERSION
      id: string
      ok: false
      error: { code: Wechat4HelperErrorCode; message: string; retryable: boolean }
    }

const ERROR_CODES = new Set<Wechat4HelperErrorCode>([
  'PERMISSION_DENIED',
  'DATABASE_NOT_FOUND',
  'SNAPSHOT_CHANGED',
  'KEY_FORMAT_INVALID',
  'KEY_ACQUISITION_FAILED',
  'KEY_VALIDATION_FAILED',
  'UNSUPPORTED_WECHAT_VERSION',
  'INVALID_REQUEST',
  'INTERNAL',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseWechat4HelperResponse(line: string): Wechat4HelperResponse {
  if (Buffer.byteLength(line, 'utf8') > WECHAT4_HELPER_MAX_LINE_BYTES) {
    throw new Error('WeChat 4 helper response exceeded the protocol limit')
  }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('WeChat 4 helper returned invalid JSON')
  }
  if (
    !isRecord(value) ||
    value.v !== WECHAT4_HELPER_PROTOCOL_VERSION ||
    typeof value.id !== 'string' ||
    typeof value.ok !== 'boolean'
  ) {
    throw new Error('WeChat 4 helper returned an invalid response envelope')
  }
  if (value.ok) {
    if (!isRecord(value.result)) throw new Error('WeChat 4 helper returned an invalid result')
    return value as Wechat4HelperResponse
  }
  if (
    !isRecord(value.error) ||
    typeof value.error.code !== 'string' ||
    !ERROR_CODES.has(value.error.code as Wechat4HelperErrorCode) ||
    typeof value.error.message !== 'string' ||
    typeof value.error.retryable !== 'boolean'
  ) {
    throw new Error('WeChat 4 helper returned an invalid error')
  }
  return value as Wechat4HelperResponse
}
