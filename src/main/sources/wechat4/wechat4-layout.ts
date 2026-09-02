import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { chmod, copyFile, lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const DATABASE_NAMES = ['emoticon.db', 'emoticon.db-wal', 'emoticon.db-shm'] as const
const SNAPSHOT_ATTEMPTS = 3

export const DEFAULT_WECHAT4_ROOT = join(
  homedir(),
  'Library',
  'Containers',
  'com.tencent.xinWeChat',
  'Data',
  'Documents',
  'xwechat_files',
)

export type Wechat4DiscoveryErrorCode = 'PERMISSION_DENIED' | 'LAYOUT_UNREADABLE'

export interface Wechat4AccountView {
  id: string
  label: string
  databaseBytes: number
  walPresent: boolean
  shmPresent: boolean
  keyMetadataPresent: boolean
}

export interface Wechat4DiscoveryView {
  rootFound: boolean
  permissionDenied: boolean
  accounts: Wechat4AccountView[]
  failures: Array<{ code: Wechat4DiscoveryErrorCode; message: string }>
}

interface Wechat4Account extends Wechat4AccountView {
  accountDirectory: string
  databaseDirectory: string
}

export interface Wechat4Snapshot {
  directory: string
  databasePath: string
  sidecars: Array<'emoticon.db-wal' | 'emoticon.db-shm'>
}

export class Wechat4SnapshotChangedError extends Error {
  constructor() {
    super('微信数据库在复制期间持续变化；请完全退出微信后重试')
    this.name = 'Wechat4SnapshotChangedError'
  }
}

function accountId(directoryName: string): string {
  return `wechat4-${createHash('sha256').update(directoryName).digest('hex').slice(0, 16)}`
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

async function regularFile(path: string): Promise<BigIntStats | null> {
  try {
    const details = await lstat(path, { bigint: true })
    return details.isFile() && !details.isSymbolicLink() ? details : null
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

async function hasKeyMetadata(accountDirectory: string): Promise<boolean> {
  const loginDirectory = join(accountDirectory, 'login')
  let loginEntries
  try {
    loginEntries = await readdir(loginDirectory, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }

  for (const entry of loginEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (await regularFile(join(loginDirectory, entry.name, 'key_info.db'))) return true
  }
  return false
}

async function discoverInternal(
  root: string,
  options: { inspectKeyMetadata?: boolean } = {},
): Promise<{
  rootFound: boolean
  permissionDenied: boolean
  accounts: Wechat4Account[]
  failures: Wechat4DiscoveryView['failures']
}> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return { rootFound: false, permissionDenied: false, accounts: [], failures: [] }
    }
    if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM')) {
      return {
        rootFound: true,
        permissionDenied: true,
        accounts: [],
        failures: [{ code: 'PERMISSION_DENIED', message: '没有读取微信 4.x 数据目录的权限' }],
      }
    }
    return {
      rootFound: true,
      permissionDenied: false,
      accounts: [],
      failures: [{ code: 'LAYOUT_UNREADABLE', message: '无法检查微信 4.x 数据目录' }],
    }
  }

  const accounts: Wechat4Account[] = []
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))

  for (const entry of candidates) {
    const accountDirectory = join(root, entry.name)
    const databaseDirectory = join(accountDirectory, 'db_storage', 'emoticon')
    try {
      const database = await regularFile(join(databaseDirectory, 'emoticon.db'))
      if (!database) continue
      const [wal, shm, keyMetadataPresent] = await Promise.all([
        regularFile(join(databaseDirectory, 'emoticon.db-wal')),
        regularFile(join(databaseDirectory, 'emoticon.db-shm')),
        options.inspectKeyMetadata === false ? false : hasKeyMetadata(accountDirectory),
      ])
      accounts.push({
        id: accountId(entry.name),
        label: `新版微信账号 ${entry.name.slice(-4)}`,
        databaseBytes: Number(database.size),
        walPresent: wal !== null,
        shmPresent: shm !== null,
        keyMetadataPresent,
        accountDirectory,
        databaseDirectory,
      })
    } catch (error) {
      if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM')) {
        return {
          rootFound: true,
          permissionDenied: true,
          accounts: [],
          failures: [{ code: 'PERMISSION_DENIED', message: '没有读取新版微信账号数据的权限' }],
        }
      }
    }
  }

  return { rootFound: true, permissionDenied: false, accounts, failures: [] }
}

export async function discoverWechat4(root = DEFAULT_WECHAT4_ROOT): Promise<Wechat4DiscoveryView> {
  const discovery = await discoverInternal(root)
  return {
    ...discovery,
    accounts: discovery.accounts.map(
      ({
        accountDirectory: _accountDirectory,
        databaseDirectory: _databaseDirectory,
        ...account
      }) => account,
    ),
  }
}

export interface Wechat4EmoticonTarget {
  id: string
  walPresent: boolean
  shmPresent: boolean
}

export interface Wechat4EmoticonCachePaths {
  /** Full-size persistent cache; preferred when present. */
  persistPath?: string
  /** Thumbnail cache; usable only after the normal image decoder validates it. */
  thumbPath?: string
}

export interface Wechat4StoreLayout {
  /** Used only inside the main process to derive the account-scoped container key. */
  accountDirectoryName: string
  containers: Map<string, string>
}

/** Gate G discovery intentionally avoids even inspecting key-metadata or any non-emoticon DB. */
export async function discoverWechat4EmoticonTargets(
  root = DEFAULT_WECHAT4_ROOT,
): Promise<Wechat4EmoticonTarget[]> {
  const discovery = await discoverInternal(root, { inspectKeyMetadata: false })
  if (discovery.permissionDenied || discovery.failures.length > 0) {
    throw new Error('WeChat 4 emoticon database discovery failed')
  }
  return discovery.accounts.map(({ id, walPresent, shmPresent }) => ({
    id,
    walPresent,
    shmPresent,
  }))
}

/**
 * Resolves only the documented MD5-sharded emoticon cache. It never scans message media and never
 * follows symlinks. Returned paths stay in the main process and must not be logged or sent to UI.
 */
export async function resolveWechat4EmoticonCache(
  accountIdToResolve: string,
  md5: string,
  root = DEFAULT_WECHAT4_ROOT,
): Promise<Wechat4EmoticonCachePaths> {
  const resolved = await resolveWechat4EmoticonCaches(accountIdToResolve, [md5], root)
  return resolved.get(md5) ?? {}
}

export async function resolveWechat4EmoticonCaches(
  accountIdToResolve: string,
  identifiers: readonly string[],
  root = DEFAULT_WECHAT4_ROOT,
): Promise<Map<string, Wechat4EmoticonCachePaths>> {
  if (
    identifiers.length > 100_000 ||
    identifiers.some((identifier) => !/^[a-f0-9]{32}$/.test(identifier))
  ) {
    throw new TypeError('Invalid WeChat emoticon identifier')
  }
  const discovery = await discoverInternal(root, { inspectKeyMetadata: false })
  const account = discovery.accounts.find((candidate) => candidate.id === accountIdToResolve)
  if (!account) throw new Error('选择的新版微信账号已不可用')

  const base = join(account.accountDirectory, 'business', 'emoticon')
  const resolved = new Map<string, Wechat4EmoticonCachePaths>()
  for (const md5 of identifiers) {
    const shard = md5.slice(0, 2)
    const persistPath = join(base, 'Persist', shard, md5)
    const thumbPath = join(base, 'Thumb', shard, `${md5}.thumb`)
    const [persist, thumb] = await Promise.all([regularFile(persistPath), regularFile(thumbPath)])
    resolved.set(md5, {
      ...(persist ? { persistPath } : {}),
      ...(thumb ? { thumbPath } : {}),
    })
  }
  return resolved
}

/**
 * Resolves only official-pack container files explicitly named by the decrypted catalog. The
 * account directory name and paths must remain in the main process and must never be logged or sent
 * to the renderer.
 */
export async function resolveWechat4StoreLayout(
  accountIdToResolve: string,
  packageIds: readonly string[],
  root = DEFAULT_WECHAT4_ROOT,
): Promise<Wechat4StoreLayout> {
  if (
    packageIds.length > 10_000 ||
    packageIds.some((packageId) => !/^[a-z0-9._:-]{1,1024}$/i.test(packageId))
  ) {
    throw new TypeError('Invalid WeChat official-emoticon package identifier')
  }
  const discovery = await discoverInternal(root, { inspectKeyMetadata: false })
  const account = discovery.accounts.find((candidate) => candidate.id === accountIdToResolve)
  if (!account) throw new Error('选择的新版微信账号已不可用')

  const wanted = new Map<string, string>()
  for (const packageId of packageIds) {
    if (/^[a-f0-9]{32}$/i.test(packageId)) wanted.set(packageId.toLowerCase(), packageId)
    wanted.set(createHash('md5').update(packageId).digest('hex'), packageId)
  }

  const containers = new Map<string, string>()
  const storeDirectory = join(account.accountDirectory, 'business', 'emoticon', 'PersistStore')
  const shards = await readdir(storeDirectory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  for (const shard of shards) {
    if (!shard.isDirectory() || shard.isSymbolicLink()) continue
    const shardDirectory = join(storeDirectory, shard.name)
    const entries = await readdir(shardDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      const packageId = wanted.get(entry.name.toLowerCase())
      if (!packageId || containers.has(packageId)) continue
      const path = join(shardDirectory, entry.name)
      if (await regularFile(path)) containers.set(packageId, path)
    }
  }

  return {
    accountDirectoryName: account.accountDirectory.split('/').at(-1)!,
    containers,
  }
}

interface FileFingerprint {
  name: (typeof DATABASE_NAMES)[number]
  size: string
  inode: string
  modified: string
  changed: string
}

async function fingerprint(directory: string): Promise<FileFingerprint[]> {
  const files: FileFingerprint[] = []
  for (const name of DATABASE_NAMES) {
    const details = await regularFile(join(directory, name))
    if (!details) continue
    files.push({
      name,
      size: details.size.toString(),
      inode: details.ino.toString(),
      modified: details.mtimeNs.toString(),
      changed: details.ctimeNs.toString(),
    })
  }
  return files
}

function sameFingerprint(left: FileFingerprint[], right: FileFingerprint[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function copySnapshotAttempt(
  databaseDirectory: string,
  signal?: AbortSignal,
  temporaryParent = tmpdir(),
): Promise<Wechat4Snapshot | null> {
  signal?.throwIfAborted()
  const before = await fingerprint(databaseDirectory)
  if (before[0]?.name !== 'emoticon.db') throw new Error('微信 4.x 表情数据库已不可用')

  const directory = await mkdtemp(join(temporaryParent, 'cn-memes-wechat4-snapshot-'))
  await chmod(directory, 0o700)
  try {
    for (const source of before) {
      signal?.throwIfAborted()
      const destination = join(directory, source.name)
      await copyFile(join(databaseDirectory, source.name), destination)
      await chmod(destination, 0o600)
      const handle = await open(destination, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    signal?.throwIfAborted()
    const after = await fingerprint(databaseDirectory)
    if (!sameFingerprint(before, after)) {
      await rm(directory, { recursive: true, force: true })
      return null
    }
    return {
      directory,
      databasePath: join(directory, 'emoticon.db'),
      sidecars: before
        .map((file) => file.name)
        .filter((name): name is 'emoticon.db-wal' | 'emoticon.db-shm' => name !== 'emoticon.db'),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function snapshotWechat4Database(
  accountIdToSnapshot: string,
  options: { root?: string; signal?: AbortSignal; temporaryParent?: string } = {},
): Promise<Wechat4Snapshot> {
  const discovery = await discoverInternal(options.root ?? DEFAULT_WECHAT4_ROOT, {
    inspectKeyMetadata: false,
  })
  const account = discovery.accounts.find((candidate) => candidate.id === accountIdToSnapshot)
  if (!account) throw new Error('选择的新版微信账号或数据库已不可用')

  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const snapshot = await copySnapshotAttempt(
      account.databaseDirectory,
      options.signal,
      options.temporaryParent,
    )
    if (snapshot) return snapshot
  }
  throw new Wechat4SnapshotChangedError()
}

export async function removeWechat4Snapshot(snapshot: Wechat4Snapshot): Promise<void> {
  await rm(snapshot.directory, { recursive: true, force: true })
}
