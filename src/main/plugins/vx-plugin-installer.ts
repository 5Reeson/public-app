import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'

import { unzipSync } from 'fflate'

import {
  VX_PLUGIN_API_VERSION,
  VX_PLUGIN_DISTRIBUTION_SCHEMA_VERSION,
  type VxPluginCapability,
  type VxPluginInstallProgress,
} from '../../shared/vx-plugin.js'
import {
  VxPluginManager,
  parseVxPluginManifest,
  type VxPluginManifest,
} from './vx-plugin-capability.js'

const MAX_INDEX_BYTES = 256 * 1024
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 384 * 1024 * 1024
const MAX_ZIP_ENTRIES = 5
const INDEX_TIMEOUT_MS = 20_000
const PACKAGE_TIMEOUT_MS = 2 * 60_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/
const ZIP_CENTRAL_HEADER = 0x02014b50
const ZIP_END_HEADER = 0x06054b50
const ZIP_END_MIN_BYTES = 22
const ZIP_END_SEARCH_BYTES = 65_535 + ZIP_END_MIN_BYTES

export interface VxPluginPackageDescriptor {
  pluginVersion: string
  pluginApiVersion: number
  architectures: string[]
  format: 'zip'
  url: string
  sha256: string
  sizeBytes: number
}

export interface VxPluginDistributionIndex {
  schemaVersion: number
  packages: VxPluginPackageDescriptor[]
}

export interface VxPluginInstallerOptions {
  architecture: string
  installRoot: string
  indexUrl?: string
  fetch?: typeof fetch
  activate: () => Promise<VxPluginCapability>
  onProgress?: (progress: VxPluginInstallProgress) => void
}

interface PreparedPlugin {
  directory: string
  manifest: VxPluginManifest
}

class DistributionError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function fixedHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

function packageDescriptor(value: unknown): VxPluginPackageDescriptor {
  if (!isRecord(value)) throw new DistributionError('组件分发索引中的安装包配置无效。')
  if (typeof value.pluginVersion !== 'string' || !VERSION_PATTERN.test(value.pluginVersion)) {
    throw new DistributionError('组件分发索引中的版本信息无效。')
  }
  if (typeof value.pluginApiVersion !== 'number' || !Number.isInteger(value.pluginApiVersion)) {
    throw new DistributionError('组件分发索引中的接口版本无效。')
  }
  if (
    !Array.isArray(value.architectures) ||
    value.architectures.length === 0 ||
    value.architectures.length > 8 ||
    value.architectures.some(
      (architecture) =>
        typeof architecture !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(architecture),
    )
  ) {
    throw new DistributionError('组件分发索引中的架构信息无效。')
  }
  if (value.format !== 'zip') {
    throw new DistributionError('当前应用不支持该组件安装包格式。')
  }
  if (typeof value.url !== 'string' || value.url.length === 0 || value.url.length > 2_048) {
    throw new DistributionError('组件分发索引中的下载地址无效。')
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new DistributionError('组件分发索引中的完整性信息无效。')
  }
  if (
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    value.sizeBytes > MAX_PACKAGE_BYTES
  ) {
    throw new DistributionError('组件安装包大小信息无效。')
  }
  return {
    pluginVersion: value.pluginVersion,
    pluginApiVersion: value.pluginApiVersion,
    architectures: [...new Set(value.architectures)],
    format: 'zip',
    url: value.url,
    sha256: value.sha256.toLowerCase(),
    sizeBytes: value.sizeBytes,
  }
}

export function parseVxPluginDistributionIndex(value: unknown): VxPluginDistributionIndex {
  if (!isRecord(value) || value.schemaVersion !== VX_PLUGIN_DISTRIBUTION_SCHEMA_VERSION) {
    throw new DistributionError('组件分发索引版本不受支持。')
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 32) {
    throw new DistributionError('组件分发索引中没有可用安装包。')
  }
  return {
    schemaVersion: value.schemaVersion,
    packages: value.packages.map(packageDescriptor),
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = Math.max(0, bytes.byteLength - ZIP_END_SEARCH_BYTES)
  for (let offset = bytes.byteLength - ZIP_END_MIN_BYTES; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_HEADER) return offset
  }
  throw new DistributionError('组件安装包不是有效的 ZIP 文件。')
}

function inspectZip(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const endOffset = findEndOfCentralDirectory(bytes)
  const diskNumber = view.getUint16(endOffset + 4, true)
  const centralDisk = view.getUint16(endOffset + 6, true)
  const entries = view.getUint16(endOffset + 10, true)
  const centralSize = view.getUint32(endOffset + 12, true)
  const centralOffset = view.getUint32(endOffset + 16, true)
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entries === 0 ||
    entries > MAX_ZIP_ENTRIES ||
    centralOffset === 0xffffffff ||
    centralSize === 0xffffffff ||
    centralOffset + centralSize > endOffset
  ) {
    throw new DistributionError('组件安装包 ZIP 结构不受支持。')
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const names: string[] = []
  let offset = centralOffset
  let totalSize = 0
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_HEADER) {
      throw new DistributionError('组件安装包 ZIP 目录已损坏。')
    }
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const externalAttributes = view.getUint32(offset + 38, true)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (
      (flags & 0x1) !== 0 ||
      (method !== 0 && method !== 8) ||
      uncompressedSize === 0xffffffff ||
      nextOffset > bytes.byteLength
    ) {
      throw new DistributionError('组件安装包包含不受支持的 ZIP 条目。')
    }
    let name: string
    try {
      name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    } catch {
      throw new DistributionError('组件安装包中的文件名无效。')
    }
    const unixType = (externalAttributes >>> 16) & 0xf000
    if (
      !name ||
      name.length > 255 ||
      basename(name) !== name ||
      name === '.' ||
      name === '..' ||
      name.includes('\\') ||
      unixType === 0xa000 ||
      names.includes(name)
    ) {
      throw new DistributionError('组件安装包包含不安全的文件条目。')
    }
    totalSize += uncompressedSize
    if (totalSize > MAX_UNCOMPRESSED_BYTES) {
      throw new DistributionError('组件安装包解压后的体积过大。')
    }
    names.push(name)
    offset = nextOffset
  }
  if (offset !== centralOffset + centralSize) {
    throw new DistributionError('组件安装包 ZIP 目录大小不匹配。')
  }
  return names
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    return isRecord(error) && error.code === 'ENOENT' ? false : Promise.reject(error)
  }
}

export class VxPluginInstaller {
  private readonly architecture: string
  private readonly installRoot: string
  private readonly indexUrl: string | undefined
  private readonly fetchImplementation: typeof fetch
  private readonly activate: () => Promise<VxPluginCapability>
  private readonly onProgress: ((progress: VxPluginInstallProgress) => void) | undefined
  private installing = false

  constructor(options: VxPluginInstallerOptions) {
    this.architecture = options.architecture
    this.installRoot = options.installRoot
    this.indexUrl = fixedHttpsUrl(options.indexUrl)
    this.fetchImplementation = options.fetch ?? fetch
    this.activate = options.activate
    this.onProgress = options.onProgress
  }

  getRemoteInstallAvailable(): boolean {
    return this.indexUrl !== undefined
  }

  async installFromRemote(): Promise<VxPluginCapability> {
    if (!this.indexUrl) throw new DistributionError('当前构建未配置在线组件下载地址。')
    return this.exclusive(async () => {
      this.progress('checking', '正在检查可用组件')
      const index = await this.fetchIndex(this.indexUrl!)
      const descriptor = index.packages.find(
        (candidate) =>
          candidate.pluginApiVersion === VX_PLUGIN_API_VERSION &&
          candidate.architectures.includes(this.architecture),
      )
      if (!descriptor) throw new DistributionError('没有适用于当前应用和处理器的组件安装包。')
      const packageUrl = this.resolvePackageUrl(descriptor.url, this.indexUrl!)
      await mkdir(this.installRoot, { recursive: true, mode: 0o700 })
      const temporaryRoot = await mkdtemp(join(this.installRoot, '.download-'))
      const archivePath = join(temporaryRoot, 'plugin.zip')
      try {
        await this.downloadPackage(packageUrl, archivePath, descriptor)
        return await this.prepareAndActivate(archivePath, temporaryRoot, descriptor)
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  async installFromLocalPackage(packagePath: string): Promise<VxPluginCapability> {
    return this.exclusive(async () => {
      this.progress('verifying', '正在验证本地组件安装包')
      await access(packagePath, constants.R_OK).catch(() => {
        throw new DistributionError('无法读取所选组件安装包。')
      })
      await mkdir(this.installRoot, { recursive: true, mode: 0o700 })
      const temporaryRoot = await mkdtemp(join(this.installRoot, '.local-'))
      try {
        return await this.prepareAndActivate(packagePath, temporaryRoot)
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  private async exclusive(task: () => Promise<VxPluginCapability>) {
    if (this.installing) throw new DistributionError('组件安装任务正在进行中。')
    this.installing = true
    try {
      return await task()
    } finally {
      this.installing = false
    }
  }

  private progress(
    phase: VxPluginInstallProgress['phase'],
    message: string,
    bytes?: { completedBytes: number; totalBytes?: number },
  ): void {
    this.onProgress?.({ phase, message, ...bytes })
  }

  private async fetchIndex(indexUrl: string): Promise<VxPluginDistributionIndex> {
    const response = await this.fetchWithTimeout(indexUrl, INDEX_TIMEOUT_MS).catch(() => {
      throw new DistributionError('无法连接组件分发服务，请稍后重试。')
    })
    if (!response.ok) throw new DistributionError('组件分发服务暂时不可用，请稍后重试。')
    if (!fixedHttpsUrl(response.url || indexUrl)) {
      throw new DistributionError('组件分发服务跳转到了不安全的地址。')
    }
    const bytes = await this.readResponseBytes(response, MAX_INDEX_BYTES, '组件分发索引体积异常。')
    try {
      return parseVxPluginDistributionIndex(JSON.parse(new TextDecoder().decode(bytes)))
    } catch (error) {
      if (error instanceof DistributionError) throw error
      throw new DistributionError('组件分发索引已损坏。')
    }
  }

  private resolvePackageUrl(value: string, indexUrl: string): string {
    try {
      const url = new URL(value, indexUrl)
      const validated = fixedHttpsUrl(url.toString())
      if (!validated) throw new Error('not https')
      return validated
    } catch {
      throw new DistributionError('组件下载地址必须使用 HTTPS。')
    }
  }

  private async downloadPackage(
    packageUrl: string,
    targetPath: string,
    descriptor: VxPluginPackageDescriptor,
  ): Promise<void> {
    this.progress('downloading', '正在下载组件', {
      completedBytes: 0,
      totalBytes: descriptor.sizeBytes,
    })
    const response = await this.fetchWithTimeout(packageUrl, PACKAGE_TIMEOUT_MS).catch(() => {
      throw new DistributionError('组件下载失败，请检查网络后重试。')
    })
    if (!response.ok || !response.body) throw new DistributionError('组件下载失败，请稍后重试。')
    if (!fixedHttpsUrl(response.url || packageUrl)) {
      throw new DistributionError('组件下载跳转到了不安全的地址。')
    }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PACKAGE_BYTES) {
      throw new DistributionError('组件安装包体积过大。')
    }

    const file = await open(targetPath, 'wx', 0o600)
    const hash = createHash('sha256')
    let downloaded = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value: bytes } = await reader.read()
        if (done) break
        downloaded += bytes.byteLength
        if (downloaded > MAX_PACKAGE_BYTES || downloaded > descriptor.sizeBytes) {
          throw new DistributionError('组件安装包大小与分发索引不匹配。')
        }
        await file.write(bytes)
        hash.update(bytes)
        this.progress('downloading', '正在下载组件', {
          completedBytes: downloaded,
          totalBytes: descriptor.sizeBytes,
        })
      }
      await file.sync()
    } finally {
      reader.releaseLock()
      await file.close()
    }
    if (downloaded !== descriptor.sizeBytes) {
      throw new DistributionError('组件安装包大小与分发索引不匹配。')
    }
    if (hash.digest('hex') !== descriptor.sha256) {
      throw new DistributionError('组件安装包完整性校验失败。')
    }
  }

  private async prepareAndActivate(
    archivePath: string,
    temporaryRoot: string,
    expected?: VxPluginPackageDescriptor,
  ): Promise<VxPluginCapability> {
    this.progress('verifying', '正在校验组件文件')
    const archiveDetails = await lstat(archivePath).catch(() => {
      throw new DistributionError('无法读取组件安装包。')
    })
    if (
      !archiveDetails.isFile() ||
      archiveDetails.isSymbolicLink() ||
      archiveDetails.size <= 0 ||
      archiveDetails.size > MAX_PACKAGE_BYTES
    ) {
      throw new DistributionError('组件安装包大小或文件类型无效。')
    }
    const archive = await readFile(archivePath)
    const names = inspectZip(archive)
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(archive)
    } catch {
      throw new DistributionError('组件安装包无法解压。')
    }
    if (!names.includes('manifest.json') || !files['manifest.json']) {
      throw new DistributionError('组件安装包缺少 manifest.json。')
    }
    let manifest: VxPluginManifest
    try {
      manifest = parseVxPluginManifest(
        JSON.parse(new TextDecoder().decode(files['manifest.json'])) as unknown,
      )
    } catch {
      throw new DistributionError('组件安装包中的 manifest.json 无效。')
    }
    const expectedNames = new Set([
      'manifest.json',
      manifest.artifacts.helper.fileName,
      manifest.artifacts.interposer.fileName,
    ])
    if (
      expectedNames.size !== 3 ||
      names.length !== 3 ||
      names.some((name) => !expectedNames.has(name)) ||
      [...expectedNames].some((name) => !files[name])
    ) {
      throw new DistributionError('组件安装包中的文件与 manifest.json 不一致。')
    }
    if (
      expected &&
      (manifest.pluginVersion !== expected.pluginVersion ||
        manifest.pluginApiVersion !== expected.pluginApiVersion ||
        !manifest.architectures.some((architecture) =>
          expected.architectures.includes(architecture),
        ))
    ) {
      throw new DistributionError('组件安装包与分发索引不匹配。')
    }

    const preparedDirectory = join(temporaryRoot, 'prepared')
    await mkdir(preparedDirectory, { mode: 0o700 })
    await Promise.all([
      writeFile(join(preparedDirectory, 'manifest.json'), files['manifest.json'], { mode: 0o600 }),
      writeFile(
        join(preparedDirectory, manifest.artifacts.helper.fileName),
        files[manifest.artifacts.helper.fileName]!,
        { mode: 0o700 },
      ),
      writeFile(
        join(preparedDirectory, manifest.artifacts.interposer.fileName),
        files[manifest.artifacts.interposer.fileName]!,
        { mode: 0o700 },
      ),
    ])
    await Promise.all([
      chmod(join(preparedDirectory, manifest.artifacts.helper.fileName), 0o755),
      chmod(join(preparedDirectory, manifest.artifacts.interposer.fileName), 0o755),
    ])

    const prepared = await this.validatePreparedPlugin(preparedDirectory, manifest)
    this.progress('installing', '正在安装组件')
    const capability = await this.activatePreparedPlugin(prepared)
    this.progress('complete', '组件安装完成')
    return capability
  }

  private async validatePreparedPlugin(
    directory: string,
    manifest: VxPluginManifest,
  ): Promise<PreparedPlugin> {
    const manager = new VxPluginManager({
      architecture: this.architecture,
      roots: [directory],
    })
    const capability = await manager.refresh()
    if (capability.state !== 'ready') {
      const reason = capability.state === 'incompatible' ? capability.reason : '组件文件缺失'
      throw new DistributionError(`组件校验失败：${reason}。`)
    }
    return { directory, manifest }
  }

  private async activatePreparedPlugin(prepared: PreparedPlugin): Promise<VxPluginCapability> {
    const currentDirectory = join(this.installRoot, 'current')
    const backupDirectory = join(this.installRoot, `.previous-${randomUUID()}`)
    const hadPrevious = await exists(currentDirectory)
    if (hadPrevious) await rename(currentDirectory, backupDirectory)
    try {
      await rename(prepared.directory, currentDirectory)
      const capability = await this.activate()
      if (
        capability.state !== 'ready' ||
        capability.pluginVersion !== prepared.manifest.pluginVersion ||
        capability.pluginApiVersion !== prepared.manifest.pluginApiVersion ||
        capability.architecture !== this.architecture
      ) {
        throw new DistributionError('组件安装后未能通过运行时检测。')
      }
      if (hadPrevious) {
        await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
      return capability
    } catch (error) {
      await rm(currentDirectory, { recursive: true, force: true }).catch(() => undefined)
      if (hadPrevious) await rename(backupDirectory, currentDirectory).catch(() => undefined)
      await this.activate().catch(() => undefined)
      if (error instanceof DistributionError) throw error
      throw new DistributionError('组件安装失败，原有组件已保留。')
    }
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await this.fetchImplementation(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Accept: 'application/json, application/zip;q=0.9, */*;q=0.1' },
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readResponseBytes(
    response: Response,
    maximumBytes: number,
    sizeError: string,
  ): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new DistributionError(sizeError)
    }
    if (!response.body) throw new DistributionError('组件分发服务返回了空响应。')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maximumBytes) throw new DistributionError(sizeError)
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
}
