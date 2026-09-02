import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VxPluginManager } from '../../src/main/plugins/vx-plugin-capability.js'
import {
  VxPluginInstaller,
  fixedHttpsUrl,
  parseVxPluginDistributionIndex,
} from '../../src/main/plugins/vx-plugin-installer.js'
import type { VxPluginCapability } from '../../src/shared/vx-plugin.js'

const cleanup: string[] = []
const helperName = 'vx-helper'
const interposerName = 'libvx-interposer.dylib'

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vx-plugin-installer-'))
  cleanup.push(root)
  return root
}

function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)
  return body
}

function pluginArchive(overrides: Record<string, unknown> = {}): Uint8Array {
  const helper = new TextEncoder().encode('new helper')
  const interposer = new TextEncoder().encode('new interposer')
  const manifest = {
    schemaVersion: 1,
    pluginApiVersion: 1,
    pluginVersion: '0.2.0',
    architectures: ['arm64', 'x64'],
    artifacts: {
      helper: { fileName: helperName, sha256: digest(helper) },
      interposer: { fileName: interposerName, sha256: digest(interposer) },
    },
    ...overrides,
  }
  return zipSync({
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
    [helperName]: helper,
    [interposerName]: interposer,
  })
}

async function writeOldPlugin(installRoot: string): Promise<void> {
  const current = join(installRoot, 'current')
  await mkdir(current, { recursive: true })
  const helper = 'old helper'
  const interposer = 'old interposer'
  await Promise.all([
    writeFile(join(current, helperName), helper),
    writeFile(join(current, interposerName), interposer),
  ])
  await Promise.all([
    chmod(join(current, helperName), 0o755),
    chmod(join(current, interposerName), 0o755),
  ])
  await writeFile(
    join(current, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      pluginApiVersion: 1,
      pluginVersion: '0.1.0',
      architectures: ['arm64'],
      artifacts: {
        helper: { fileName: helperName, sha256: digest(helper) },
        interposer: { fileName: interposerName, sha256: digest(interposer) },
      },
    }),
  )
}

function installer(
  installRoot: string,
  options: {
    indexUrl?: string
    fetch?: typeof fetch
    activate?: () => Promise<VxPluginCapability>
  } = {},
): VxPluginInstaller {
  const manager = new VxPluginManager({
    architecture: 'arm64',
    roots: [join(installRoot, 'current')],
  })
  return new VxPluginInstaller({
    architecture: 'arm64',
    installRoot,
    ...(options.indexUrl ? { indexUrl: options.indexUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    activate: options.activate ?? (() => manager.refresh()),
  })
}

describe('VxPluginInstaller', () => {
  it('installs a selected local ZIP and restores executable permissions', async () => {
    const root = await temporaryRoot()
    const archivePath = join(root, 'plugin.zip')
    await writeFile(archivePath, pluginArchive())
    const installRoot = join(root, 'plugins')

    await expect(installer(installRoot).installFromLocalPackage(archivePath)).resolves.toEqual({
      state: 'ready',
      pluginVersion: '0.2.0',
      pluginApiVersion: 1,
      architecture: 'arm64',
    })
    expect((await stat(join(installRoot, 'current', helperName))).mode & 0o111).not.toBe(0)
    expect(await readFile(join(installRoot, 'current', helperName), 'utf8')).toBe('new helper')
  })

  it('downloads from a fixed HTTPS index and verifies package size and SHA-256', async () => {
    const root = await temporaryRoot()
    const archive = pluginArchive()
    const index = JSON.stringify({
      schemaVersion: 1,
      packages: [
        {
          pluginVersion: '0.2.0',
          pluginApiVersion: 1,
          architectures: ['arm64', 'x64'],
          format: 'zip',
          url: './vx-plugin-0.2.0-macos-universal.zip',
          sha256: digest(archive),
          sizeBytes: archive.byteLength,
        },
      ],
    })
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      return url.endsWith('index.json')
        ? new Response(index, { status: 200 })
        : new Response(responseBody(archive), {
            status: 200,
            headers: { 'content-length': String(archive.byteLength) },
          })
    })

    const result = await installer(join(root, 'plugins'), {
      indexUrl: 'https://plugins.example.test/vx/index.json',
      fetch: fetchMock,
    }).installFromRemote()

    expect(result).toMatchObject({ state: 'ready', pluginVersion: '0.2.0' })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://plugins.example.test/vx/vx-plugin-0.2.0-macos-universal.zip',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('rejects non-HTTPS distribution configuration', async () => {
    const root = await temporaryRoot()
    const subject = installer(join(root, 'plugins'), {
      indexUrl: 'http://plugins.example.test/index.json',
    })

    expect(fixedHttpsUrl('http://plugins.example.test/index.json')).toBeUndefined()
    expect(subject.getRemoteInstallAvailable()).toBe(false)
    await expect(subject.installFromRemote()).rejects.toThrow('未配置在线组件下载地址')
  })

  it('rejects a ZIP with a path traversal entry', async () => {
    const root = await temporaryRoot()
    const archivePath = join(root, 'plugin.zip')
    await writeFile(
      archivePath,
      zipSync({
        '../outside': new Uint8Array([1]),
        'manifest.json': new TextEncoder().encode('{}'),
      }),
    )

    await expect(
      installer(join(root, 'plugins')).installFromLocalPackage(archivePath),
    ).rejects.toThrow('不安全的文件条目')
  })

  it('rejects a local package with an incompatible plugin API', async () => {
    const root = await temporaryRoot()
    const archivePath = join(root, 'plugin.zip')
    await writeFile(archivePath, pluginArchive({ pluginApiVersion: 2 }))

    await expect(
      installer(join(root, 'plugins')).installFromLocalPackage(archivePath),
    ).rejects.toThrow('插件接口版本与当前应用不兼容')
  })

  it('keeps the previous plugin when activation fails', async () => {
    const root = await temporaryRoot()
    const installRoot = join(root, 'plugins')
    await writeOldPlugin(installRoot)
    const archivePath = join(root, 'plugin.zip')
    await writeFile(archivePath, pluginArchive())
    const activate = vi.fn(async () => ({
      state: 'incompatible' as const,
      reason: 'synthetic activation failure',
    }))

    await expect(
      installer(installRoot, { activate }).installFromLocalPackage(archivePath),
    ).rejects.toThrow('安装后未能通过运行时检测')
    expect(await readFile(join(installRoot, 'current', helperName), 'utf8')).toBe('old helper')
    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed indexes and package hashes before activation', async () => {
    expect(() => parseVxPluginDistributionIndex({ schemaVersion: 1, packages: [] })).toThrow(
      '没有可用安装包',
    )

    const root = await temporaryRoot()
    const archive = pluginArchive()
    const index = JSON.stringify({
      schemaVersion: 1,
      packages: [
        {
          pluginVersion: '0.2.0',
          pluginApiVersion: 1,
          architectures: ['arm64'],
          format: 'zip',
          url: './plugin.zip',
          sha256: '0'.repeat(64),
          sizeBytes: archive.byteLength,
        },
      ],
    })
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('index.json')
        ? new Response(index, { status: 200 })
        : new Response(responseBody(archive), { status: 200 }),
    )

    await expect(
      installer(join(root, 'plugins'), {
        indexUrl: 'https://plugins.example.test/index.json',
        fetch: fetchMock,
      }).installFromRemote(),
    ).rejects.toThrow('完整性校验失败')
  })
})
