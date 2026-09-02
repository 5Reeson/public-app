const MAX_CATALOG_BYTES = 16 * 1024 * 1024
const MAX_CATALOG_RECORDS = 100_000
const MAX_FIELD_BYTES = 16 * 1024
const MD5 = /^[a-f0-9]{32}$/

export type Wechat4PersonalEmoticonGroup = 'favorite' | 'custom'

export interface Wechat4PersonalEmoticon {
  order: number
  group: Wechat4PersonalEmoticonGroup
  type: number
  md5: string
  caption: string
  thumbUrl: string
  tpUrl: string
  cdnUrl: string
  externUrl: string
  encryptUrl: string
  aesKey: string
  authKey: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_BYTES
}

function parseRecord(value: unknown, expectedOrder: number): Wechat4PersonalEmoticon {
  if (!isRecord(value)) throw new Error('WeChat 4 helper returned an invalid catalog record')
  const strings = [
    value.md5,
    value.caption,
    value.thumbUrl,
    value.tpUrl,
    value.cdnUrl,
    value.externUrl,
    value.encryptUrl,
    value.aesKey,
    value.authKey,
  ]
  if (
    value.order !== expectedOrder ||
    (value.group !== 'favorite' && value.group !== 'custom') ||
    !Number.isSafeInteger(value.type) ||
    !strings.every(boundedString) ||
    !MD5.test(value.md5 as string)
  ) {
    throw new Error('WeChat 4 helper returned an invalid catalog record')
  }
  return value as unknown as Wechat4PersonalEmoticon
}

/**
 * Parses the sensitive row stream delivered over helper fd 4. Callers must not log the input,
 * parsed records, or thrown causes. The containing runner clears the transport buffer after use.
 */
export function parseWechat4PersonalEmoticonCatalog(bytes: Buffer): Wechat4PersonalEmoticon[] {
  if (bytes.length > MAX_CATALOG_BYTES) {
    throw new Error('WeChat 4 helper catalog exceeded the protocol limit')
  }
  const serialized = bytes.toString('utf8')
  const lines = serialized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length > MAX_CATALOG_RECORDS) {
    throw new Error('WeChat 4 helper catalog exceeded the record limit')
  }

  const records: Wechat4PersonalEmoticon[] = []
  const seen = new Set<string>()
  for (const [index, line] of lines.entries()) {
    if (!line || Buffer.byteLength(line, 'utf8') > MAX_FIELD_BYTES * 9 + 512) {
      throw new Error('WeChat 4 helper returned invalid catalog framing')
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error('WeChat 4 helper returned invalid catalog JSON')
    }
    const record = parseRecord(value, index)
    if (seen.has(record.md5)) {
      throw new Error('WeChat 4 helper returned a duplicate catalog record')
    }
    seen.add(record.md5)
    records.push(record)
  }
  return records
}

export function clearWechat4PersonalEmoticonCatalog(records: Wechat4PersonalEmoticon[]): void {
  for (const record of records) {
    record.md5 = ''
    record.caption = ''
    record.thumbUrl = ''
    record.tpUrl = ''
    record.cdnUrl = ''
    record.externUrl = ''
    record.encryptUrl = ''
    record.aesKey = ''
    record.authKey = ''
  }
  records.length = 0
}
