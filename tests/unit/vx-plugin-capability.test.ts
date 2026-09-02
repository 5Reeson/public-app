import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  VxPluginManager,
  type VxPluginManifest,
} from '../../src/main/plugins/vx-plugin-capability.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vx-plugin-capability-'))
  cleanup.push(root)
  return root
}

function digest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function manifest(overrides: Partial<VxPluginManifest> = {}): VxPluginManifest {
  return {
    schemaVersion: 1,
    pluginApiVersion: 1,
    pluginVersion: '0.1.0',
    architectures: ['arm64', 'x64'],
    artifacts: {
      helper: { fileName: 'vx-helper', sha256: digest('helper') },
      interposer: {
        fileName: 'libvx-interposer.dylib',
        sha256: digest('interposer'),
      },
    },
    install: { pageUrl: 'https://downloads.example.test/vx-plugin' },
    ...overrides,
  }
}

async function writeManifest(root: string, value: unknown): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'manifest.json'), JSON.stringify(value))
}

async function writeArtifacts(root: string): Promise<void> {
  await Promise.all([
    writeFile(join(root, 'vx-helper'), 'helper'),
    writeFile(join(root, 'libvx-interposer.dylib'), 'interposer'),
  ])
  await Promise.all([
    chmod(join(root, 'vx-helper'), 0o700),
    chmod(join(root, 'libvx-interposer.dylib'), 0o700),
  ])
}

async function readyRoot(): Promise<string> {
  const root = await temporaryRoot()
  await writeArtifacts(root)
  await writeManifest(root, manifest())
  return root
}

function manager(root: string, architecture = 'arm64'): VxPluginManager {
  return new VxPluginManager({ architecture, roots: [root] })
}

describe('VxPluginManager', () => {
  it('returns a path-free ready capability for a compatible manifest and artifacts', async () => {
    const root = await readyRoot()
    const pluginManager = manager(root)

    await expect(pluginManager.refresh()).resolves.toEqual({
      state: 'ready',
      pluginVersion: '0.1.0',
      pluginApiVersion: 1,
      architecture: 'arm64',
    })
    expect(JSON.stringify(pluginManager.getCapability())).not.toContain(root)
    expect(pluginManager.getReadyPlugin()?.artifacts).toEqual({
      helperPath: join(root, 'vx-helper'),
      interposerPath: join(root, 'libvx-interposer.dylib'),
    })
  })

  it('returns missing without inventing an install action', async () => {
    const root = await temporaryRoot()
    const pluginManager = manager(root)

    await expect(pluginManager.refresh()).resolves.toEqual({ state: 'missing' })
    expect(pluginManager.getInstallPageUrl()).toBeUndefined()
  })

  it('uses a validated fixed install page for a missing plugin', async () => {
    const root = await temporaryRoot()
    const pluginManager = new VxPluginManager({
      architecture: 'arm64',
      roots: [root],
      defaultInstallPageUrl: 'https://install.example.test/vx',
    })

    await expect(pluginManager.refresh()).resolves.toEqual({
      state: 'missing',
      installPageUrl: 'https://install.example.test/vx',
    })
  })

  it('reports a damaged manifest as incompatible', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'manifest.json'), '{broken')

    await expect(manager(root).refresh()).resolves.toMatchObject({
      state: 'incompatible',
      reason: '插件清单已损坏',
    })
  })

  it('rejects unsupported schema and plugin API versions', async () => {
    const root = await readyRoot()
    await writeManifest(root, manifest({ schemaVersion: 2 }))
    await expect(manager(root).refresh()).resolves.toMatchObject({
      state: 'incompatible',
      reason: '插件清单版本不受支持',
    })

    await writeManifest(root, manifest({ pluginApiVersion: 2 }))
    await expect(manager(root).refresh()).resolves.toMatchObject({
      state: 'incompatible',
      reason: '插件接口版本与当前应用不兼容',
    })
  })

  it('rejects a plugin for a different CPU architecture', async () => {
    const root = await readyRoot()
    await writeManifest(root, manifest({ architectures: ['x64'] }))

    await expect(manager(root, 'arm64').refresh()).resolves.toMatchObject({
      state: 'incompatible',
      reason: '插件不支持当前 Mac 的处理器架构',
    })
  })

  it.each([
    ['helper', 'vx-helper'],
    ['interposer', 'libvx-interposer.dylib'],
  ] as const)('rejects a missing %s', async (label, fileName) => {
    const root = await readyRoot()
    await rm(join(root, fileName))

    await expect(manager(root).refresh()).resolves.toMatchObject({
      state: 'incompatible',
      reason: `${label}文件缺失`,
    })
  })

  it('rejects a helper without executable permission', async () => {
    const root = await readyRoot()
    await chmod(join(root, 'vx-helper'), 0o600)

    await expect(manager(root).refresh()).resolves.toMatchObject({
      state: 'incompatible',
      reason: 'helper文件不可执行',
    })
  })

  it('rejects a non-HTTPS installation page and never exposes it', async () => {
    const root = await readyRoot()
    await writeManifest(root, manifest({ install: { pageUrl: 'http://install.example.test' } }))
    const pluginManager = manager(root)

    await expect(pluginManager.refresh()).resolves.toMatchObject({
      state: 'incompatible',
      reason: '安装说明地址必须使用 HTTPS',
    })
    expect(pluginManager.getInstallPageUrl()).toBeUndefined()
  })

  it('rejects artifact bytes that do not match the SHA-256 manifest', async () => {
    const root = await readyRoot()
    await writeFile(join(root, 'vx-helper'), 'tampered')
    await chmod(join(root, 'vx-helper'), 0o700)

    await expect(manager(root).refresh()).resolves.toMatchObject({
      state: 'incompatible',
      reason: '插件文件完整性校验失败',
    })
  })

  it('updates missing to ready after files are installed and refresh is requested', async () => {
    const root = await temporaryRoot()
    const pluginManager = manager(root)
    await expect(pluginManager.refresh()).resolves.toEqual({ state: 'missing' })

    await writeArtifacts(root)
    await writeManifest(root, manifest())

    await expect(pluginManager.refresh()).resolves.toMatchObject({ state: 'ready' })
    expect(pluginManager.getReadyPlugin()).toBeDefined()
  })

  it('does not expose native paths in incompatible reasons', async () => {
    const root = await readyRoot()
    await rm(join(root, 'vx-helper'))
    const capability = await manager(root).refresh()

    expect(JSON.stringify(capability)).not.toContain(root)
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toContain('vx-helper')
  })
})
