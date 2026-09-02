import { describe, expect, it } from 'vitest'

import { extractStickerUrlsFromPlistXml } from '../../src/main/sources/wechat-legacy/fav-archive.js'

describe('fav.archive plist parsing', () => {
  it('extracts unique HTTP URLs in archive order and decodes XML entities', () => {
    const result = extractStickerUrlsFromPlistXml(`
      <?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0">
        <dict>
          <key>$archiver</key><string>NSKeyedArchiver</string>
          <key>$objects</key>
          <array>
            <string>https://stickers.example/first.gif?a=1&amp;b=2</string>
            <string>not a URL</string>
            <string>http://stickers.example/second.png</string>
            <string>https://stickers.example/first.gif?a=1&amp;b=2</string>
            <string>http://[invalid</string>
            <string>ftp://stickers.example/ignored</string>
          </array>
        </dict>
      </plist>
    `)

    expect(result).toEqual({
      urls: ['https://stickers.example/first.gif?a=1&b=2', 'http://stickers.example/second.png'],
      stringCount: 7,
      duplicateUrls: 1,
      invalidUrls: 1,
    })
  })

  it('rejects URLs containing embedded credentials', () => {
    const result = extractStickerUrlsFromPlistXml(
      '<plist><array><string>https://user:secret@example.com/sticker</string></array></plist>',
    )

    expect(result.urls).toEqual([])
    expect(result.invalidUrls).toBe(1)
  })
})
