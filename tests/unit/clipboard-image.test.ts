import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { renderClipboardPng } from '../../src/main/library/clipboard-image.js'

describe('clipboard image', () => {
  let temporaryDirectory: string | undefined

  afterEach(async () => {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  })

  it('renders an imported image as clipboard-compatible PNG data', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'clipboard-image-'))
    const sourcePath = join(temporaryDirectory, 'source.webp')
    await writeFile(
      sourcePath,
      await sharp({ create: { width: 3, height: 2, channels: 4, background: '#336699' } })
        .webp()
        .toBuffer(),
    )

    const png = await renderClipboardPng(sourcePath)
    const metadata = await sharp(png).metadata()

    expect(metadata.format).toBe('png')
    expect(metadata.width).toBe(3)
    expect(metadata.height).toBe(2)
    await expect(readFile(sourcePath)).resolves.not.toHaveLength(0)
  })
})
