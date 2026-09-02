import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AppUpdateService,
  isNewerVersion,
  readBuildFlavor,
  shouldCheckForUpdatesAutomatically,
} from '../../src/main/updates/app-update-service.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'app-update-'))
  cleanup.push(directory)
  return directory
}

async function service(
  response: Response,
  overrides: { now?: () => number; interval?: number } = {},
) {
  const root = await temporaryDirectory()
  const request = vi.fn<typeof fetch>().mockResolvedValue(response)
  return {
    request,
    updateService: new AppUpdateService({
      currentVersion: '0.1.0',
      latestReleaseApiUrl: 'https://api.github.test/repos/example/app/releases/latest',
      automaticCheckIntervalMs: overrides.interval ?? 24 * 60 * 60_000,
      requestTimeoutMs: 1_000,
      lastCheckPath: join(root, 'settings', 'app-update.json'),
      fetchLatestRelease: request,
      ...(overrides.now ? { now: overrides.now } : {}),
    }),
  }
}

function release(tagName: string): Response {
  return Response.json({ tag_name: tagName })
}

describe('AppUpdateService', () => {
  it('reports and retains a newer stable release without sending a token', async () => {
    const { request, updateService } = await service(release('v0.2.0'))

    await expect(updateService.check()).resolves.toEqual({
      status: 'available',
      update: { currentVersion: '0.1.0', latestVersion: '0.2.0' },
    })
    expect(updateService.getState().availableUpdate?.latestVersion).toBe('0.2.0')
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
  })

  it('reports up-to-date and treats network or malformed responses as unavailable', async () => {
    const current = await service(release('v0.1.0'))
    await expect(current.updateService.check()).resolves.toMatchObject({ status: 'up-to-date' })

    const failed = await service(new Response('rate limited', { status: 403 }))
    await expect(failed.updateService.check()).resolves.toMatchObject({ status: 'unavailable' })

    const malformed = await service(Response.json({ name: 'missing tag' }))
    await expect(malformed.updateService.check()).resolves.toMatchObject({
      status: 'unavailable',
    })

    const invalidVersion = await service(release('not-a-version'))
    await expect(invalidVersion.updateService.check()).resolves.toMatchObject({
      status: 'unavailable',
    })
  })

  it('throttles automatic checks for the configured interval', async () => {
    let now = 1_000
    const { request, updateService } = await service(release('v0.2.0'), {
      now: () => now,
      interval: 24 * 60 * 60_000,
    })

    await expect(updateService.checkAutomaticallyIfDue()).resolves.toBeDefined()
    await expect(updateService.checkAutomaticallyIfDue()).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledOnce()

    now += 24 * 60 * 60_000
    await expect(updateService.checkAutomaticallyIfDue()).resolves.toBeDefined()
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('update version and flavor rules', () => {
  it('compares semantic release versions needed by 0.0.x validation', () => {
    expect(isNewerVersion('v0.0.2', '0.0.1')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('broken', '0.1.0')).toBe(false)
  })

  it('enables automatic checks only for packaged official builds', () => {
    expect(shouldCheckForUpdatesAutomatically(true, 'official')).toBe(true)
    expect(shouldCheckForUpdatesAutomatically(false, 'official')).toBe(false)
    expect(shouldCheckForUpdatesAutomatically(true, 'community')).toBe(false)
  })

  it('reads the packaged flavor metadata and defaults safely to community', async () => {
    const official = await temporaryDirectory()
    const community = await temporaryDirectory()
    await writeFile(join(official, 'package.json'), JSON.stringify({ buildFlavor: 'official' }))
    await writeFile(join(community, 'package.json'), JSON.stringify({}))

    await expect(readBuildFlavor(official)).resolves.toBe('official')
    await expect(readBuildFlavor(community)).resolves.toBe('community')
  })
})
