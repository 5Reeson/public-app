import { describe, expect, it } from 'vitest'

import { parseWechat4PersonalEmoticonCatalog } from '../../src/main/sources/wechat4/personal-emoticon-catalog.js'

function line(order: number, md5: string): string {
  return JSON.stringify({
    order,
    group: 'favorite',
    type: 1,
    md5,
    caption: '',
    thumbUrl: '',
    tpUrl: '',
    cdnUrl: '',
    externUrl: '',
    encryptUrl: '',
    aesKey: '',
    authKey: '',
  })
}

describe('WeChat 4 personal emoticon catalog parser', () => {
  it('accepts bounded sequential records', () => {
    const records = parseWechat4PersonalEmoticonCatalog(
      Buffer.from(
        `${line(0, '00000000000000000000000000000001')}\n${line(
          1,
          '00000000000000000000000000000002',
        )}\n`,
      ),
    )
    expect(records.map((record) => record.order)).toEqual([0, 1])
  })

  it('rejects reordered, duplicate, and malformed records without echoing their content', () => {
    const duplicate = `${line(0, '00000000000000000000000000000001')}\n${line(
      1,
      '00000000000000000000000000000001',
    )}\n`
    expect(() => parseWechat4PersonalEmoticonCatalog(Buffer.from(duplicate))).toThrow(
      /duplicate catalog record/i,
    )
    expect(() =>
      parseWechat4PersonalEmoticonCatalog(
        Buffer.from(`${line(2, '00000000000000000000000000000002')}\n`),
      ),
    ).toThrow(/invalid catalog record/i)
    expect(() => parseWechat4PersonalEmoticonCatalog(Buffer.from('{private-row'))).toThrow(
      'WeChat 4 helper returned invalid catalog JSON',
    )
  })
})
