import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { BufferJSON } from '@whiskeysockets/baileys'
import { safeStorage } from 'electron'

import {
  createEmptyAuthState,
  createLoadedAuthState,
  hasPairedCredentials,
  type LoadedWhatsAppAuthState,
  type StoredAuthState,
  type WhatsAppAuthStore,
} from './auth-store.js'

export { hasPairedCredentials } from './auth-store.js'
export type { LoadedWhatsAppAuthState as LoadedEncryptedAuthState } from './auth-store.js'

export class EncryptedAuthStore implements WhatsAppAuthStore {
  private stored: StoredAuthState | undefined
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private assertEncryptionAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('macOS 安全存储当前不可用，无法安全保存 WhatsApp 登录信息')
    }
  }

  private async readStored(): Promise<StoredAuthState | undefined> {
    let encrypted: Buffer
    try {
      encrypted = await readFile(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('无法读取钥匙串保护的 WhatsApp 登录凭证', { cause: error })
    }
    this.assertEncryptionAvailable()
    try {
      const plaintext = safeStorage.decryptString(encrypted)
      return JSON.parse(plaintext, BufferJSON.reviver) as StoredAuthState
    } catch (error) {
      throw new Error('无法解密 WhatsApp 登录凭证；请清除登录后重新关联', { cause: error })
    }
  }

  private async persist(): Promise<void> {
    this.assertEncryptionAvailable()
    const stored = this.stored
    if (!stored) return
    const write = async () => {
      const directory = dirname(this.path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const encrypted = safeStorage.encryptString(JSON.stringify(stored, BufferJSON.replacer))
      const temporaryPath = `${this.path}.${process.pid}.tmp`
      await writeFile(temporaryPath, encrypted, { mode: 0o600 })
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
    }
    this.saveQueue = this.saveQueue.then(write, write)
    try {
      await this.saveQueue
    } catch (error) {
      throw new Error('无法保存钥匙串保护的 WhatsApp 登录凭证', { cause: error })
    }
  }

  async hasSession(): Promise<boolean> {
    const stored = this.stored ?? (await this.readStored())
    return stored ? hasPairedCredentials(stored.creds) : false
  }

  async load(): Promise<LoadedWhatsAppAuthState> {
    this.stored = this.stored ?? (await this.readStored()) ?? createEmptyAuthState()
    const stored = this.stored
    return createLoadedAuthState(stored, () => this.persist())
  }

  async clear(): Promise<void> {
    await this.saveQueue.catch(() => undefined)
    this.stored = undefined
    try {
      await unlink(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('无法删除钥匙串保护的 WhatsApp 登录凭证', { cause: error })
      }
    }
  }
}
