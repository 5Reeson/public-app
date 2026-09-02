import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ExportTaskStore } from '../../src/main/exports/export-task-store.js'
import { ManifestStore } from '../../src/main/library/manifest-store.js'
import { VxPluginManager } from '../../src/main/plugins/vx-plugin-capability.js'
import { SendReceiptStore } from '../../src/main/whatsapp/send-receipt-store.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('optional VX plugin startup', () => {
  it('allows library, archive workflow, and WhatsApp state stores to initialize when missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'optional-vx-startup-'))
    cleanup.push(root)
    const pluginManager = new VxPluginManager({
      architecture: 'arm64',
      roots: [join(root, 'plugins', 'vx', 'current')],
    })

    const [capability, collection, task, receipt] = await Promise.all([
      pluginManager.refresh(),
      new ManifestStore(join(root, 'library', 'default')).loadOrCreate(),
      new ExportTaskStore({ path: join(root, 'exports', 'current-task.json') }).loadOrCreate(),
      new SendReceiptStore(join(root, 'whatsapp', 'receipts.json')).getMessageId('target', 'pack'),
    ])

    expect(capability).toEqual({ state: 'missing' })
    expect(collection.assets).toEqual([])
    expect(task.currentStep).toBe(1)
    expect(receipt).toBeUndefined()
  })
})
