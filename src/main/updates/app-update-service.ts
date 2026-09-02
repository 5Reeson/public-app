import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  AppUpdateCheckResult,
  AppUpdateInfo,
  AppUpdateState,
} from '../../shared/app-update.js'

export type AppBuildFlavor = 'community' | 'official'

interface AppUpdateServiceOptions {
  currentVersion: string
  latestReleaseApiUrl: string
  automaticCheckIntervalMs: number
  requestTimeoutMs: number
  lastCheckPath: string
  fetchLatestRelease?: typeof fetch
  now?: () => number
}

interface ReleaseResponse {
  tag_name?: unknown
}

interface ParsedVersion {
  parts: [number, number, number]
  prerelease: boolean
}

export class AppUpdateService {
  private readonly fetchLatestRelease: typeof fetch
  private readonly now: () => number
  private availableUpdate: AppUpdateInfo | undefined
  private activeCheck: Promise<AppUpdateCheckResult> | undefined

  constructor(private readonly options: AppUpdateServiceOptions) {
    this.fetchLatestRelease = options.fetchLatestRelease ?? fetch
    this.now = options.now ?? Date.now
  }

  getState(): AppUpdateState {
    return {
      currentVersion: this.options.currentVersion,
      ...(this.availableUpdate ? { availableUpdate: this.availableUpdate } : {}),
    }
  }

  check(): Promise<AppUpdateCheckResult> {
    if (this.activeCheck) return this.activeCheck
    this.activeCheck = this.runCheck().finally(() => {
      this.activeCheck = undefined
    })
    return this.activeCheck
  }

  async checkAutomaticallyIfDue(): Promise<AppUpdateCheckResult | undefined> {
    const lastCheckAt = await this.readLastCheckAt()
    if (
      lastCheckAt !== undefined &&
      this.now() - lastCheckAt < this.options.automaticCheckIntervalMs
    ) {
      return undefined
    }
    await this.writeLastCheckAt(this.now())
    return this.check()
  }

  private async runCheck(): Promise<AppUpdateCheckResult> {
    try {
      const response = await this.fetchLatestRelease(this.options.latestReleaseApiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'tudu-update-checker',
        },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      })
      if (!response.ok) throw new Error(`Release request failed: ${response.status}`)
      const release = (await response.json()) as ReleaseResponse
      if (typeof release.tag_name !== 'string') throw new Error('Release version is missing')
      if (!parseVersion(release.tag_name) || !parseVersion(this.options.currentVersion)) {
        throw new Error('Release version is invalid')
      }
      if (!isNewerVersion(release.tag_name, this.options.currentVersion)) {
        this.availableUpdate = undefined
        return { status: 'up-to-date', currentVersion: this.options.currentVersion }
      }
      this.availableUpdate = {
        currentVersion: this.options.currentVersion,
        latestVersion: normalizeVersion(release.tag_name),
      }
      return { status: 'available', update: this.availableUpdate }
    } catch {
      return { status: 'unavailable', currentVersion: this.options.currentVersion }
    }
  }

  private async readLastCheckAt(): Promise<number | undefined> {
    try {
      const value = JSON.parse(await readFile(this.options.lastCheckPath, 'utf8')) as {
        lastCheckAt?: unknown
      }
      return typeof value.lastCheckAt === 'number' ? value.lastCheckAt : undefined
    } catch {
      return undefined
    }
  }

  private async writeLastCheckAt(lastCheckAt: number): Promise<void> {
    try {
      await mkdir(dirname(this.options.lastCheckPath), { recursive: true })
      await writeFile(this.options.lastCheckPath, JSON.stringify({ lastCheckAt }))
    } catch {
      // A read-only settings directory should not prevent a one-off update check.
    }
  }
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate)
  const installed = parseVersion(current)
  if (!next || !installed) return false
  for (let index = 0; index < next.parts.length; index += 1) {
    const difference = next.parts[index]! - installed.parts[index]!
    if (difference !== 0) return difference > 0
  }
  return installed.prerelease && !next.prerelease
}

export function shouldCheckForUpdatesAutomatically(
  isPackaged: boolean,
  flavor: AppBuildFlavor,
): boolean {
  return isPackaged && flavor === 'official'
}

export async function readBuildFlavor(appPath: string): Promise<AppBuildFlavor> {
  try {
    const metadata = JSON.parse(await readFile(join(appPath, 'package.json'), 'utf8')) as {
      buildFlavor?: unknown
    }
    return metadata.buildFlavor === 'official' ? 'official' : 'community'
  } catch {
    return 'community'
  }
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (!match) return undefined
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  }
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, '')
}
