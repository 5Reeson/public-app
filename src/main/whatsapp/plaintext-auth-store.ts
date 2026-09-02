import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { BufferJSON } from '@whiskeysockets/baileys'

import {
  createEmptyAuthState,
  createLoadedAuthState,
  hasPairedCredentials,
  type LoadedWhatsAppAuthState,
  type StoredAuthState,
  type WhatsAppAuthStore,
} from './auth-store.js'

export class PlaintextAuthStore implements WhatsAppAuthStore {
  private stored: StoredAuthState | undefined
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private async readStored(): Promise<StoredAuthState | undefined> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'), BufferJSON.reviver) as StoredAuthState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('无法读取本地明文 WhatsApp 登录凭证；请清除登录后重新关联', {
        cause: error,
      })
    }
  }

  private async persist(): Promise<void> {
    const stored = this.stored
    if (!stored) return
    const write = async () => {
      const directory = dirname(this.path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporaryPath, JSON.stringify(stored, BufferJSON.replacer), {
          mode: 0o600,
          flag: 'wx',
        })
        await rename(temporaryPath, this.path)
        await chmod(this.path, 0o600)
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined)
        throw error
      }
    }
    this.saveQueue = this.saveQueue.then(write, write)
    try {
      await this.saveQueue
    } catch (error) {
      throw new Error('无法保存本地明文 WhatsApp 登录凭证', { cause: error })
    }
  }

  async hasSession(): Promise<boolean> {
    const stored = this.stored ?? (await this.readStored())
    return stored ? hasPairedCredentials(stored.creds) : false
  }

  async load(): Promise<LoadedWhatsAppAuthState> {
    this.stored = this.stored ?? (await this.readStored()) ?? createEmptyAuthState()
    return createLoadedAuthState(this.stored, () => this.persist())
  }

  async clear(): Promise<void> {
    await this.saveQueue.catch(() => undefined)
    this.stored = undefined
    try {
      await unlink(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('无法删除本地明文 WhatsApp 登录凭证', { cause: error })
      }
    }
  }
}
