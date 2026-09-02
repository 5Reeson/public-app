import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface StoredReceipt {
  messageId: string
  sentAt: string
}

interface ReceiptFile {
  schemaVersion: 1
  receipts: Record<string, StoredReceipt>
}

const emptyFile = (): ReceiptFile => ({ schemaVersion: 1, receipts: {} })

export class SendReceiptStore {
  private data: ReceiptFile | undefined
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private key(targetId: string, packId: string): string {
    const targetHash = createHash('sha256').update(targetId).digest('hex')
    return `${targetHash}:${packId}`
  }

  private async load(): Promise<ReceiptFile> {
    if (this.data) return this.data
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ReceiptFile>
      if (parsed.schemaVersion !== 1 || !parsed.receipts || typeof parsed.receipts !== 'object') {
        throw new Error('发送记录格式无效')
      }
      this.data = parsed as ReceiptFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.data = emptyFile()
    }
    return this.data
  }

  private async save(): Promise<void> {
    const data = await this.load()
    const write = async () => {
      const directory = dirname(this.path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporaryPath = `${this.path}.${process.pid}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
    }
    this.saveQueue = this.saveQueue.then(write, write)
    await this.saveQueue
  }

  async getMessageId(targetId: string, packId: string): Promise<string | undefined> {
    return (await this.load()).receipts[this.key(targetId, packId)]?.messageId
  }

  async record(targetId: string, packId: string, messageId: string): Promise<void> {
    const data = await this.load()
    data.receipts[this.key(targetId, packId)] = { messageId, sentAt: new Date().toISOString() }
    await this.save()
  }
}
