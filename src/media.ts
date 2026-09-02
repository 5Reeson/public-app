import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getMediaKeys, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '@whiskeysockets/baileys'

export type StickerPackMediaType = 'sticker-pack' | 'thumbnail-sticker-pack'

export interface EncryptedMedia {
  encFilePath: string
  fileEncSha256: Buffer
  fileLength: number
  fileSha256: Buffer
  mediaKey: Buffer
}

/**
 * Baileys already contains the generic media encryption and upload machinery,
 * but rc14 has not yet added these two server-side media routes to its maps.
 */
export function enableStickerPackMediaTypes(): void {
  const paths = MEDIA_PATH_MAP as Record<string, string>
  const hkdfNames = MEDIA_HKDF_KEY_MAPPING as Record<string, string>

  paths['sticker-pack'] = '/mms/sticker-pack'
  paths['thumbnail-sticker-pack'] = '/mms/thumbnail-sticker-pack'
  hkdfNames['sticker-pack'] = 'Sticker Pack'
  hkdfNames['thumbnail-sticker-pack'] = 'Sticker Pack Thumbnail'
}

/** Encrypts a complete in-memory payload with WhatsApp's media envelope. */
export async function encryptMedia(
  plaintext: Buffer,
  mediaType: StickerPackMediaType,
  existingMediaKey?: Buffer,
): Promise<EncryptedMedia> {
  const mediaKey = existingMediaKey ?? randomBytes(32)
  const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType as never)
  if (!macKey) {
    throw new Error(`Baileys did not derive a MAC key for ${mediaType}`)
  }

  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const mac = createHmac('sha256', macKey).update(iv).update(encrypted).digest().subarray(0, 10)
  const encryptedWithMac = Buffer.concat([encrypted, mac])

  const directory = join(tmpdir(), 'cn-memes-abroad-whatsapp')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const encFilePath = join(directory, `${mediaType}-${randomBytes(10).toString('hex')}.enc`)
  await writeFile(encFilePath, encryptedWithMac, { mode: 0o600 })

  return {
    encFilePath,
    fileEncSha256: createHash('sha256').update(encryptedWithMac).digest(),
    fileLength: plaintext.length,
    fileSha256: createHash('sha256').update(plaintext).digest(),
    mediaKey,
  }
}
