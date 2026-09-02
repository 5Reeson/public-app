import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { safeStorage } from 'electron'

const ACCOUNT_ID = /^wechat4-[a-f0-9]{16}$/
const HEX_16 = /^[a-f0-9]{32}$/

interface EncryptionBoundary {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface StoredKey {
  v: 1
  key: string
}

export interface Wechat4StoreKeyCache {
  load(accountId: string): Promise<Buffer | undefined>
  save(accountId: string, key: Buffer): Promise<void>
  clear(accountId: string): Promise<void>
}

/** Keychain-backed cache for a fully validated official-emoticon container key. */
export class Wechat4StoreKeyStore implements Wechat4StoreKeyCache {
  constructor(
    private readonly directory: string,
    private readonly encryption: EncryptionBoundary = safeStorage,
  ) {}

  private path(accountId: string): string {
    if (!ACCOUNT_ID.test(accountId)) throw new TypeError('Invalid WeChat 4 account ID')
    return join(this.directory, `${accountId}.store-keychain`)
  }

  private assertAvailable(): void {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error('macOS 安全存储当前不可用，无法安全保存微信官方表情访问信息')
    }
  }

  async load(accountId: string): Promise<Buffer | undefined> {
    this.assertAvailable()
    let encrypted: Buffer
    try {
      encrypted = await readFile(this.path(accountId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('无法读取微信官方表情安全存储', { cause: error })
    }
    try {
      const parsed = JSON.parse(this.encryption.decryptString(encrypted)) as Partial<StoredKey>
      if (parsed.v !== 1 || !HEX_16.test(parsed.key ?? '')) {
        throw new Error('Invalid encrypted store key')
      }
      return Buffer.from(parsed.key!, 'hex')
    } catch (error) {
      throw new Error('无法解密微信官方表情访问信息；请清除后重新获取', { cause: error })
    } finally {
      encrypted.fill(0)
    }
  }

  async save(accountId: string, key: Buffer): Promise<void> {
    this.assertAvailable()
    if (key.length !== 16) throw new TypeError('Invalid WeChat 4 store key')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const encrypted = this.encryption.encryptString(
      JSON.stringify({ v: 1, key: key.toString('hex') } satisfies StoredKey),
    )
    const destination = this.path(accountId)
    const temporary = `${destination}.${process.pid}-${randomUUID()}.tmp`
    try {
      await writeFile(temporary, encrypted, { mode: 0o600 })
      await rename(temporary, destination)
      await chmod(destination, 0o600)
    } finally {
      encrypted.fill(0)
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  async clear(accountId: string): Promise<void> {
    await unlink(this.path(accountId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
