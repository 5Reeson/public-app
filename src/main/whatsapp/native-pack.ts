import { createHash } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'

import { generateWAMessageFromContent, proto, type WASocket } from '@whiskeysockets/baileys'
import { zipSync } from 'fflate'
import sharp from 'sharp'

import {
  enableStickerPackMediaTypes,
  encryptMedia,
  type StickerPackMediaType,
} from '../../media.js'
import type { PreparedPack } from '../packs/pack-preparer.js'

type UploadFunction = WASocket['waUploadToServer']

export interface NativeStickerPackPayload {
  stickerFiles: Array<{ fileName: string; contents: Buffer }>
  trayFileName: string
  trayPng: Buffer
  thumbnailJpeg: Buffer
  zip: Buffer
}

async function encryptAndUpload(
  upload: UploadFunction,
  contents: Buffer,
  mediaType: StickerPackMediaType,
  mediaKey?: Buffer,
) {
  const encrypted = await encryptMedia(contents, mediaType, mediaKey)
  try {
    const result = await upload(encrypted.encFilePath, {
      fileEncSha256B64: encrypted.fileEncSha256.toString('base64'),
      mediaType: mediaType as never,
      timeoutMs: 60_000,
    })
    return { encrypted, directPath: result.directPath }
  } finally {
    await unlink(encrypted.encFilePath).catch(() => undefined)
  }
}

export async function buildNativeStickerPackPayload(
  pack: PreparedPack,
): Promise<NativeStickerPackPayload> {
  if (pack.status !== 'prepared' || pack.stickers.length < 3 || !pack.trayPath) {
    throw new Error(`${pack.name} 尚未成功准备，不能发送`)
  }
  const stickerFiles = await Promise.all(
    pack.stickers.map(async (sticker, index) => ({
      fileName: `sticker-${String(index + 1).padStart(2, '0')}.webp`,
      contents: await readFile(sticker.outputPath),
    })),
  )
  const trayFileName = 'tray.png'
  const trayPng = await readFile(pack.trayPath)
  const thumbnailJpeg = await sharp(trayPng)
    .resize(252, 252, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .jpeg({ quality: 82 })
    .toBuffer()
  const zip = Buffer.from(
    zipSync(
      Object.fromEntries([
        ...stickerFiles.map(({ fileName, contents }) => [fileName, contents] as const),
        [trayFileName, trayPng] as const,
      ]),
      { level: 0 },
    ),
  )
  return { stickerFiles, trayFileName, trayPng, thumbnailJpeg, zip }
}

export async function sendPreparedStickerPack(
  socket: WASocket,
  targetJid: string,
  pack: PreparedPack,
): Promise<string> {
  if (!socket.user?.id) throw new Error('WhatsApp 尚未完成登录')

  enableStickerPackMediaTypes()
  const { stickerFiles, trayFileName, thumbnailJpeg, zip } =
    await buildNativeStickerPackPayload(pack)

  const packUpload = await encryptAndUpload(socket.waUploadToServer, zip, 'sticker-pack')
  const thumbnailUpload = await encryptAndUpload(
    socket.waUploadToServer,
    thumbnailJpeg,
    'thumbnail-sticker-pack',
    packUpload.encrypted.mediaKey,
  )
  const animated = pack.mediaKind === 'animated'
  const stickerPackMessage = proto.Message.StickerPackMessage.create({
    stickerPackId: `com.cn-memes-abroad.${pack.id}`,
    name: pack.name,
    publisher: pack.publisher,
    packDescription: 'Created locally with 图渡.',
    stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
    stickerPackSize: zip.length,
    stickers: stickerFiles.map(({ fileName }, index) => ({
      fileName,
      mimetype: 'image/webp',
      isAnimated: animated,
      isLottie: false,
      emojis: ['🙂'],
      accessibilityLabel: `${pack.name} ${index + 1}`,
    })),
    fileLength: packUpload.encrypted.fileLength,
    fileSha256: packUpload.encrypted.fileSha256,
    fileEncSha256: packUpload.encrypted.fileEncSha256,
    mediaKey: packUpload.encrypted.mediaKey,
    directPath: packUpload.directPath,
    mediaKeyTimestamp: Math.floor(Date.now() / 1000),
    trayIconFileName: trayFileName,
    thumbnailDirectPath: thumbnailUpload.directPath,
    thumbnailSha256: thumbnailUpload.encrypted.fileSha256,
    thumbnailEncSha256: thumbnailUpload.encrypted.fileEncSha256,
    thumbnailHeight: 252,
    thumbnailWidth: 252,
    imageDataHash: createHash('sha256').update(thumbnailJpeg).digest('base64'),
  })
  const outgoing = generateWAMessageFromContent(
    targetJid,
    { stickerPackMessage },
    { userJid: socket.user.id },
  )
  if (!outgoing.message || !outgoing.key.id) {
    throw new Error('WhatsApp 未能生成消息 ID')
  }
  await socket.relayMessage(targetJid, outgoing.message, { messageId: outgoing.key.id })
  return outgoing.key.id
}
