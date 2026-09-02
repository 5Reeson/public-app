import sharp from 'sharp'

export async function renderClipboardPng(originalPath: string): Promise<Buffer> {
  return sharp(originalPath, { page: 0, pages: 1 }).png().toBuffer()
}
