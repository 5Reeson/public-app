import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

interface ExportPreferences {
  schemaVersion: 1
  defaultDirectory?: string
}

export class ExportPreferencesStore {
  constructor(private readonly filePath: string) {}

  async getDefaultDirectory(): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<ExportPreferences>
      const directory = parsed.schemaVersion === 1 ? parsed.defaultDirectory : undefined
      if (!directory || !isAbsolute(directory)) return undefined
      return (await stat(directory)).isDirectory() ? directory : undefined
    } catch {
      return undefined
    }
  }

  async setDefaultDirectory(directory: string): Promise<string> {
    if (!isAbsolute(directory)) throw new TypeError('Default export directory must be absolute')
    const resolvedDirectory = await realpath(directory)
    if (!(await stat(resolvedDirectory)).isDirectory()) {
      throw new TypeError('Default export directory must be a directory')
    }

    const parent = dirname(this.filePath)
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    const preferences: ExportPreferences = {
      schemaVersion: 1,
      defaultDirectory: resolvedDirectory,
    }
    await mkdir(parent, { recursive: true, mode: DIRECTORY_MODE })
    await chmod(parent, DIRECTORY_MODE)
    try {
      await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, {
        mode: FILE_MODE,
      })
      await rename(temporaryPath, this.filePath)
      await chmod(this.filePath, FILE_MODE)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
    return resolvedDirectory
  }
}
