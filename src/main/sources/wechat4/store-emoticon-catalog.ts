const MAX_CATALOG_BYTES = 16 * 1024 * 1024
const MAX_CATALOG_RECORDS = 100_000
const MAX_FIELD_BYTES = 16 * 1024
const MD5 = /^[a-f0-9]{32}$/
const PACKAGE_ID = /^[a-z0-9._:-]{1,1024}$/i

export interface Wechat4StoreEmoticon {
  order: number
  packageId: string
  packageName: string
  downloadStatus: number
  removeTime: number
  md5: string
  type: number
  sortOrder: number
  emoticonSize: number
  emoticonOffset: number
  thumbSize: number
  thumbOffset: number
  hasEncryptedRemote: boolean
  hasAnyRemote: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return safeInteger(value) && (value as number) >= 0
}

function parseRecord(value: unknown, expectedOrder: number): Wechat4StoreEmoticon {
  if (
    !isRecord(value) ||
    value.order !== expectedOrder ||
    typeof value.packageId !== 'string' ||
    !PACKAGE_ID.test(value.packageId) ||
    Buffer.byteLength(value.packageId, 'utf8') > MAX_FIELD_BYTES ||
    typeof value.packageName !== 'string' ||
    value.packageName.trim().length === 0 ||
    Buffer.byteLength(value.packageName, 'utf8') > MAX_FIELD_BYTES ||
    typeof value.md5 !== 'string' ||
    !MD5.test(value.md5) ||
    !safeInteger(value.downloadStatus) ||
    !nonNegativeInteger(value.removeTime) ||
    !safeInteger(value.type) ||
    !safeInteger(value.sortOrder) ||
    !nonNegativeInteger(value.emoticonSize) ||
    !nonNegativeInteger(value.emoticonOffset) ||
    !nonNegativeInteger(value.thumbSize) ||
    !nonNegativeInteger(value.thumbOffset) ||
    typeof value.hasEncryptedRemote !== 'boolean' ||
    typeof value.hasAnyRemote !== 'boolean'
  ) {
    throw new Error('WeChat 4 helper returned an invalid store catalog record')
  }
  return value as unknown as Wechat4StoreEmoticon
}

export function parseWechat4StoreEmoticonCatalog(bytes: Buffer): Wechat4StoreEmoticon[] {
  if (bytes.length > MAX_CATALOG_BYTES) {
    throw new Error('WeChat 4 helper catalog exceeded the protocol limit')
  }
  const lines = bytes.toString('utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length > MAX_CATALOG_RECORDS) {
    throw new Error('WeChat 4 helper catalog exceeded the record limit')
  }

  const records: Wechat4StoreEmoticon[] = []
  const seen = new Set<string>()
  for (const [index, line] of lines.entries()) {
    if (!line || Buffer.byteLength(line, 'utf8') > MAX_FIELD_BYTES + 1_024) {
      throw new Error('WeChat 4 helper returned invalid store catalog framing')
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error('WeChat 4 helper returned invalid store catalog JSON')
    }
    const record = parseRecord(value, index)
    const identity = `${record.packageId}\0${record.md5}`
    if (seen.has(identity)) {
      throw new Error('WeChat 4 helper returned a duplicate store catalog record')
    }
    seen.add(identity)
    records.push(record)
  }
  return records
}

export function clearWechat4StoreEmoticonCatalog(records: Wechat4StoreEmoticon[]): void {
  for (const record of records) {
    record.packageId = ''
    record.packageName = ''
    record.md5 = ''
  }
  records.length = 0
}
