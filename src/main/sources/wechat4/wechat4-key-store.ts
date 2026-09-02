import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { safeStorage } from 'electron'

import type { CandidateDatabaseKey } from './candidate-key-pipe.js'
import type { Wechat4CandidateStore } from './personal-emoticon-reader.js'

const ACCOUNT_ID = /^wechat4-[a-f0-9]{16}$/
const HEX_16 = /^[a-f0-9]{32}$/
const HEX_32 = /^[a-f0-9]{64}$/

interface EncryptionBoundary {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface StoredCandidate {
  v: 1
  salt: string
  key: string
}

export class Wechat4KeyStore implements Wechat4CandidateStore {
  constructor(
    private readonly directory: string,
    private readonly encryption: EncryptionBoundary = safeStorage,
  ) {}

  private path(accountId: string): string {
    if (!ACCOUNT_ID.test(accountId)) throw new TypeError('Invalid WeChat 4 account ID')
    return join(this.directory, `${accountId}.keychain`)
  }

  private assertAvailable(): void {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error('macOS 安全存储当前不可用，无法安全保存微信数据库访问信息')
    }
  }

  async load(accountId: string): Promise<CandidateDatabaseKey | undefined> {
    this.assertAvailable()
    let encrypted: Buffer
    try {
      encrypted = await readFile(this.path(accountId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('无法读取微信数据库安全存储', { cause: error })
    }
    try {
      const parsed = JSON.parse(
        this.encryption.decryptString(encrypted),
      ) as Partial<StoredCandidate>
      if (parsed.v !== 1 || !HEX_16.test(parsed.salt ?? '') || !HEX_32.test(parsed.key ?? '')) {
        throw new Error('Invalid encrypted candidate')
      }
      const salt = parsed.salt!
      const key = parsed.key!
      return {
        role: 'emoticon',
        salt: Buffer.from(salt, 'hex'),
        key: Buffer.from(key, 'hex'),
      }
    } catch (error) {
      throw new Error('无法解密微信数据库访问信息；请清除后重新获取', { cause: error })
    } finally {
      encrypted.fill(0)
    }
  }

  async save(accountId: string, candidate: CandidateDatabaseKey): Promise<void> {
    this.assertAvailable()
    if (candidate.salt.length !== 16 || candidate.key.length !== 32) {
      throw new TypeError('Invalid WeChat 4 candidate')
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const encrypted = this.encryption.encryptString(
      JSON.stringify({
        v: 1,
        salt: candidate.salt.toString('hex'),
        key: candidate.key.toString('hex'),
      } satisfies StoredCandidate),
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
