import { describe, expect, it } from 'vitest'

import {
  clearWechat4StoreEmoticonCatalog,
  parseWechat4StoreEmoticonCatalog,
} from '../../src/main/sources/wechat4/store-emoticon-catalog.js'

const validRecord = {
  order: 0,
  packageId: '10000000000000000000000000000001',
  packageName: '合成官方专辑',
  downloadStatus: 2,
  removeTime: 0,
  md5: '20000000000000000000000000000001',
  type: 1,
  sortOrder: 1,
  emoticonSize: 20,
  emoticonOffset: 10,
  thumbSize: 8,
  thumbOffset: 30,
  hasEncryptedRemote: false,
  hasAnyRemote: false,
}

describe('WeChat 4 store emoticon catalog', () => {
  it('parses bounded package container ranges and clears sensitive identifiers', () => {
    const records = parseWechat4StoreEmoticonCatalog(
      Buffer.from(`${JSON.stringify(validRecord)}\n`),
    )
    expect(records).toEqual([validRecord])
    clearWechat4StoreEmoticonCatalog(records)
    expect(records).toEqual([])
  })

  it('rejects invalid ranges, identifiers and duplicate package entries', () => {
    expect(() =>
      parseWechat4StoreEmoticonCatalog(
        Buffer.from(`${JSON.stringify({ ...validRecord, emoticonOffset: -1 })}\n`),
      ),
    ).toThrow(/invalid store catalog record/i)
    expect(() =>
      parseWechat4StoreEmoticonCatalog(
        Buffer.from(`${JSON.stringify({ ...validRecord, md5: '../unsafe' })}\n`),
      ),
    ).toThrow(/invalid store catalog record/i)
    expect(() =>
      parseWechat4StoreEmoticonCatalog(
        Buffer.from(`${JSON.stringify({ ...validRecord, packageId: '../unsafe' })}\n`),
      ),
    ).toThrow(/invalid store catalog record/i)
    expect(() =>
      parseWechat4StoreEmoticonCatalog(
        Buffer.from(
          `${JSON.stringify({ ...validRecord, emoticonOffset: Number.MAX_SAFE_INTEGER + 1 })}\n`,
        ),
      ),
    ).toThrow(/invalid store catalog record/i)
    expect(() =>
      parseWechat4StoreEmoticonCatalog(
        Buffer.from(
          `${JSON.stringify(validRecord)}\n${JSON.stringify({ ...validRecord, order: 1 })}\n`,
        ),
      ),
    ).toThrow(/duplicate/i)
  })
})
