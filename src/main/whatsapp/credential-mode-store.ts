import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { WhatsAppCredentialMode } from '../../shared/domain.js'

const SCHEMA_VERSION = 1 as const

export class CredentialModeStore {
  constructor(private readonly path: string) {}

  async load(): Promise<WhatsAppCredentialMode> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (
        !isRecord(parsed) ||
        parsed.schemaVersion !== SCHEMA_VERSION ||
        !isCredentialMode(parsed.mode)
      ) {
        throw new Error('Unsupported WhatsApp credential mode settings')
      }
      return parsed.mode
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'keychain'
      throw new Error('无法读取 WhatsApp 凭证存储设置', { cause: error })
    }
  }

  async save(mode: WhatsAppCredentialMode): Promise<void> {
    if (!isCredentialMode(mode)) throw new TypeError('Invalid WhatsApp credential mode')
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, mode }, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' },
      )
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw new Error('无法保存 WhatsApp 凭证存储设置', { cause: error })
    }
  }
}

export function isCredentialMode(value: unknown): value is WhatsAppCredentialMode {
  return value === 'keychain' || value === 'plaintext'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
