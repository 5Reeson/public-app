import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

interface ImportPreferences {
  schemaVersion: 1
  lastImportDirectory?: string
}

export class ImportPreferencesStore {
  constructor(private readonly filePath: string) {}

  async getLastImportDirectory(): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<ImportPreferences>
      const directory = parsed.schemaVersion === 1 ? parsed.lastImportDirectory : undefined
      if (!directory || !isAbsolute(directory)) return undefined
      return (await stat(directory)).isDirectory() ? directory : undefined
    } catch {
      return undefined
    }
  }

  async setLastImportDirectory(directory: string): Promise<void> {
    if (!isAbsolute(directory)) return
    try {
      if (!(await stat(directory)).isDirectory()) return
    } catch {
      return
    }

    const parent = dirname(this.filePath)
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    const preferences: ImportPreferences = {
      schemaVersion: 1,
      lastImportDirectory: directory,
    }

    await mkdir(parent, { recursive: true, mode: 0o700 })
    await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }
}
