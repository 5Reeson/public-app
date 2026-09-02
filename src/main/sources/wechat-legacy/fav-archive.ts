import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PLUTIL_PATH = '/usr/bin/plutil'
const MAX_ARCHIVE_XML_BYTES = 64 * 1024 * 1024

export interface ParsedFavArchive {
  urls: string[]
  stringCount: number
  duplicateUrls: number
  invalidUrls: number
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity): string => {
    const named: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
    }
    const normalized = entity.toLowerCase()
    if (named[normalized]) return named[normalized]
    const hex = normalized.startsWith('&#x')
    const digits = normalized.slice(hex ? 3 : 2, -1)
    const codePoint = Number.parseInt(digits, hex ? 16 : 10)
    return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity
  })
}

export function extractStickerUrlsFromPlistXml(xml: string): ParsedFavArchive {
  const strings = [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    decodeXmlEntities(match[1]!),
  )
  const urls: string[] = []
  const seen = new Set<string>()
  let duplicateUrls = 0
  let invalidUrls = 0

  for (const value of strings) {
    if (!/^https?:\/\//i.test(value)) continue
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        invalidUrls += 1
        continue
      }
      if (seen.has(value)) {
        duplicateUrls += 1
        continue
      }
      seen.add(value)
      urls.push(value)
    } catch {
      invalidUrls += 1
    }
  }

  return { urls, stringCount: strings.length, duplicateUrls, invalidUrls }
}

export async function readFavArchive(path: string): Promise<ParsedFavArchive> {
  try {
    const { stdout } = await execFileAsync(PLUTIL_PATH, ['-convert', 'xml1', '-o', '-', path], {
      encoding: 'utf8',
      maxBuffer: MAX_ARCHIVE_XML_BYTES,
      timeout: 30_000,
    })
    return extractStickerUrlsFromPlistXml(stdout)
  } catch (error) {
    throw new Error('无法解析 fav.archive；文件可能损坏或不是受支持的 plist', {
      cause: error,
    })
  }
}
