import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SendReceiptStore } from '../../src/main/whatsapp/send-receipt-store.js'

describe('SendReceiptStore', () => {
  let temporaryDirectory: string
  let receiptPath: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'send-receipts-'))
    receiptPath = join(temporaryDirectory, 'whatsapp', 'send-receipts.json')
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('persists successful pack receipts without storing the target JID', async () => {
    const targetId = '85212345678@s.whatsapp.net'
    await new SendReceiptStore(receiptPath).record(targetId, 'pack-a', 'message-1')

    const reloaded = new SendReceiptStore(receiptPath)
    expect(await reloaded.getMessageId(targetId, 'pack-a')).toBe('message-1')
    expect(await reloaded.getMessageId(targetId, 'pack-b')).toBeUndefined()
    expect(await readFile(receiptPath, 'utf8')).not.toContain(targetId)
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600)
  })
})
