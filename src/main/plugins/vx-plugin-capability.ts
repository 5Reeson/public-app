import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import {
  VX_PLUGIN_API_VERSION,
  VX_PLUGIN_SCHEMA_VERSION,
  type VxPluginCapability,
} from '../../shared/vx-plugin.js'

const MAX_MANIFEST_BYTES = 64 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/

interface VxPluginArtifactManifest {
  fileName: string
  sha256: string
}

export interface VxPluginManifest {
  schemaVersion: number
  pluginApiVersion: number
  pluginVersion: string
  architectures: string[]
  artifacts: {
    helper: VxPluginArtifactManifest
    interposer: VxPluginArtifactManifest
  }
  install?: {
    pageUrl?: string
  }
}

export interface ReadyVxPlugin {
  capability: Extract<VxPluginCapability, { state: 'ready' }>
  artifacts: {
    helperPath: string
    interposerPath: string
  }
}

export interface VxPluginManagerOptions {
  architecture: string
  roots: string[]
  defaultInstallPageUrl?: string
}

class ManifestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalHttpsUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new ManifestError('安装说明地址格式无效')
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new ManifestError('安装说明地址必须使用 HTTPS')
    }
    return parsed.toString()
  } catch (error) {
    if (error instanceof ManifestError) throw error
    throw new ManifestError('安装说明地址格式无效')
  }
}

function artifactManifest(value: unknown, label: string): VxPluginArtifactManifest {
  if (!isRecord(value)) throw new ManifestError(`${label}配置缺失`)
  const { fileName, sha256 } = value
  if (
    typeof fileName !== 'string' ||
    fileName.length === 0 ||
    fileName.length > 255 ||
    basename(fileName) !== fileName ||
    fileName === '.' ||
    fileName === '..'
  ) {
    throw new ManifestError(`${label}文件名无效`)
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new ManifestError(`${label}完整性信息无效`)
  }
  return { fileName, sha256: sha256.toLowerCase() }
}

export function parseVxPluginManifest(value: unknown): VxPluginManifest {
  if (!isRecord(value)) throw new ManifestError('插件清单格式无效')
  if (value.schemaVersion !== VX_PLUGIN_SCHEMA_VERSION) {
    throw new ManifestError('插件清单版本不受支持')
  }
  if (typeof value.pluginApiVersion !== 'number' || !Number.isInteger(value.pluginApiVersion)) {
    throw new ManifestError('插件接口版本无效')
  }
  if (typeof value.pluginVersion !== 'string' || !VERSION_PATTERN.test(value.pluginVersion)) {
    throw new ManifestError('插件版本无效')
  }
  if (
    !Array.isArray(value.architectures) ||
    value.architectures.length === 0 ||
    value.architectures.some(
      (architecture) =>
        typeof architecture !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(architecture),
    )
  ) {
    throw new ManifestError('插件架构列表无效')
  }
  if (!isRecord(value.artifacts)) throw new ManifestError('插件文件配置缺失')
  if (value.install !== undefined && !isRecord(value.install)) {
    throw new ManifestError('插件安装信息无效')
  }
  const pageUrl = optionalHttpsUrl(value.install?.pageUrl)
  return {
    schemaVersion: value.schemaVersion,
    pluginApiVersion: value.pluginApiVersion,
    pluginVersion: value.pluginVersion,
    architectures: [...new Set(value.architectures)],
    artifacts: {
      helper: artifactManifest(value.artifacts.helper, 'helper'),
      interposer: artifactManifest(value.artifacts.interposer, 'interposer'),
    },
    ...(pageUrl === undefined ? {} : { install: { pageUrl } }),
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function validateExecutable(path: string, label: string): Promise<string | undefined> {
  try {
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink()) return `${label}文件无效`
    if ((details.mode & 0o111) === 0) return `${label}文件不可执行`
    return undefined
  } catch {
    return `${label}文件缺失`
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function incompatible(
  reason: string,
  installPageUrl: string | undefined,
): Extract<VxPluginCapability, { state: 'incompatible' }> {
  return {
    state: 'incompatible',
    reason,
    ...(installPageUrl === undefined ? {} : { installPageUrl }),
  }
}

export class VxPluginManager {
  private readonly architecture: string
  private readonly roots: string[]
  private readonly defaultInstallPageUrl: string | undefined
  private current: VxPluginCapability
  private readyPlugin: ReadyVxPlugin | undefined

  constructor(options: VxPluginManagerOptions) {
    this.architecture = options.architecture
    this.roots = [...new Set(options.roots.map((root) => resolve(root)))]
    try {
      this.defaultInstallPageUrl = optionalHttpsUrl(options.defaultInstallPageUrl)
    } catch {
      this.defaultInstallPageUrl = undefined
    }
    this.current = {
      state: 'missing',
      ...(this.defaultInstallPageUrl === undefined
        ? {}
        : { installPageUrl: this.defaultInstallPageUrl }),
    }
  }

  getCapability(): VxPluginCapability {
    return { ...this.current }
  }

  getReadyPlugin(): ReadyVxPlugin | undefined {
    if (!this.readyPlugin) return undefined
    return {
      capability: { ...this.readyPlugin.capability },
      artifacts: { ...this.readyPlugin.artifacts },
    }
  }

  getInstallPageUrl(): string | undefined {
    return this.current.state === 'ready' ? undefined : this.current.installPageUrl
  }

  async refresh(): Promise<VxPluginCapability> {
    this.readyPlugin = undefined
    for (const root of this.roots) {
      const manifestPath = join(root, 'manifest.json')
      let contents: string
      try {
        const details = await lstat(manifestPath)
        if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_MANIFEST_BYTES) {
          this.current = incompatible('插件清单文件无效', this.defaultInstallPageUrl)
          return this.getCapability()
        }
        contents = await readFile(manifestPath, 'utf8')
      } catch (error) {
        if (isMissingFileError(error)) continue
        this.current = incompatible('插件清单无法读取', this.defaultInstallPageUrl)
        return this.getCapability()
      }

      let manifest: VxPluginManifest
      try {
        manifest = parseVxPluginManifest(JSON.parse(contents) as unknown)
      } catch (error) {
        const reason = error instanceof ManifestError ? error.message : '插件清单已损坏'
        this.current = incompatible(reason, this.defaultInstallPageUrl)
        return this.getCapability()
      }
      const installPageUrl = manifest.install?.pageUrl ?? this.defaultInstallPageUrl
      if (manifest.pluginApiVersion !== VX_PLUGIN_API_VERSION) {
        this.current = incompatible('插件接口版本与当前应用不兼容', installPageUrl)
        return this.getCapability()
      }
      if (!manifest.architectures.includes(this.architecture)) {
        this.current = incompatible('插件不支持当前 Mac 的处理器架构', installPageUrl)
        return this.getCapability()
      }

      const artifacts = {
        helperPath: join(root, manifest.artifacts.helper.fileName),
        interposerPath: join(root, manifest.artifacts.interposer.fileName),
      }
      const [helperError, interposerError] = await Promise.all([
        validateExecutable(artifacts.helperPath, 'helper'),
        validateExecutable(artifacts.interposerPath, 'interposer'),
      ])
      const artifactError = helperError ?? interposerError
      if (artifactError) {
        this.current = incompatible(artifactError, installPageUrl)
        return this.getCapability()
      }
      let helperHash: string
      let interposerHash: string
      try {
        ;[helperHash, interposerHash] = await Promise.all([
          sha256(artifacts.helperPath),
          sha256(artifacts.interposerPath),
        ])
      } catch {
        this.current = incompatible('插件文件无法读取', installPageUrl)
        return this.getCapability()
      }
      if (
        helperHash !== manifest.artifacts.helper.sha256 ||
        interposerHash !== manifest.artifacts.interposer.sha256
      ) {
        this.current = incompatible('插件文件完整性校验失败', installPageUrl)
        return this.getCapability()
      }

      const capability: Extract<VxPluginCapability, { state: 'ready' }> = {
        state: 'ready',
        pluginVersion: manifest.pluginVersion,
        pluginApiVersion: manifest.pluginApiVersion,
        architecture: this.architecture,
      }
      this.current = capability
      this.readyPlugin = { capability, artifacts }
      return this.getCapability()
    }

    this.current = {
      state: 'missing',
      ...(this.defaultInstallPageUrl === undefined
        ? {}
        : { installPageUrl: this.defaultInstallPageUrl }),
    }
    return this.getCapability()
  }
}
