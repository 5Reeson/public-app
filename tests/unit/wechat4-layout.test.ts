import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  discoverWechat4,
  discoverWechat4EmoticonTargets,
  removeWechat4Snapshot,
  resolveWechat4EmoticonCache,
  resolveWechat4StoreLayout,
  snapshotWechat4Database,
} from '../../src/main/sources/wechat4/wechat4-layout.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<{ root: string; databaseDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'wechat4-layout-test-'))
  cleanup.push(root)
  const account = join(root, 'wxid_synthetic_account_abcd')
  const databaseDirectory = join(account, 'db_storage', 'emoticon')
  await mkdir(databaseDirectory, { recursive: true })
  await mkdir(join(account, 'login', 'synthetic-login'), { recursive: true })
  await Promise.all([
    writeFile(join(databaseDirectory, 'emoticon.db'), 'synthetic encrypted main'),
    writeFile(join(databaseDirectory, 'emoticon.db-wal'), 'synthetic wal'),
    writeFile(join(databaseDirectory, 'emoticon.db-shm'), 'synthetic shm'),
    writeFile(join(account, 'login', 'synthetic-login', 'key_info.db'), 'synthetic metadata'),
  ])
  return { root, databaseDirectory }
}

describe('WeChat 4 layout discovery and snapshots', () => {
  it('returns a clean no-data result when the xwechat_files root is missing', async () => {
    const root = join(tmpdir(), `missing-wechat4-${Date.now()}`)
    await expect(discoverWechat4(root)).resolves.toEqual({
      rootFound: false,
      permissionDenied: false,
      accounts: [],
      failures: [],
    })
  })

  it('discovers account databases without exposing account or database paths', async () => {
    const { root } = await fixtureRoot()
    const invalid = join(root, 'not-an-account', 'db_storage', 'emoticon')
    await mkdir(invalid, { recursive: true })
    await symlink(join(root, 'wxid_synthetic_account_abcd'), join(root, 'linked-account'))

    const result = await discoverWechat4(root)

    expect(result).toMatchObject({ rootFound: true, permissionDenied: false, failures: [] })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      label: '新版微信账号 abcd',
      walPresent: true,
      shmPresent: true,
      keyMetadataPresent: true,
    })
    expect(result.accounts[0]?.id).toMatch(/^wechat4-[a-f0-9]{16}$/)
    expect(JSON.stringify(result)).not.toContain(root)
    expect(result.accounts[0]).not.toHaveProperty('databaseDirectory')
  })

  it('copies the main database and WAL sidecars to a private controlled snapshot', async () => {
    const { root, databaseDirectory } = await fixtureRoot()
    const [account] = (await discoverWechat4(root)).accounts

    const snapshot = await snapshotWechat4Database(account!.id, { root })
    cleanup.push(snapshot.directory)

    expect(snapshot.sidecars).toEqual(['emoticon.db-wal', 'emoticon.db-shm'])
    expect(await readFile(snapshot.databasePath, 'utf8')).toBe('synthetic encrypted main')
    expect(await readFile(join(snapshot.directory, 'emoticon.db-wal'), 'utf8')).toBe(
      'synthetic wal',
    )
    expect((await stat(snapshot.directory)).mode & 0o777).toBe(0o700)
    expect((await stat(snapshot.databasePath)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(databaseDirectory, 'emoticon.db'), 'utf8')).toBe(
      'synthetic encrypted main',
    )

    await removeWechat4Snapshot(snapshot)
    cleanup.splice(cleanup.indexOf(snapshot.directory), 1)
    await expect(stat(snapshot.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discovers only emoticon targets and snapshots beneath a supplied private session', async () => {
    const { root } = await fixtureRoot()
    const session = await mkdtemp(join(tmpdir(), 'wechat4-gate-g-session-'))
    cleanup.push(session)
    const targets = await discoverWechat4EmoticonTargets(root)

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ walPresent: true, shmPresent: true })
    expect(targets[0]).not.toHaveProperty('keyMetadataPresent')

    const snapshot = await snapshotWechat4Database(targets[0]!.id, {
      root,
      temporaryParent: session,
    })
    expect(snapshot.directory.startsWith(`${session}/`)).toBe(true)
    await removeWechat4Snapshot(snapshot)
  })

  it('resolves only regular files in the MD5-sharded persistent and thumbnail caches', async () => {
    const { root } = await fixtureRoot()
    const [account] = (await discoverWechat4(root)).accounts
    const md5 = 'abcdef0123456789abcdef0123456789'
    const cacheRoot = join(root, 'wxid_synthetic_account_abcd', 'business', 'emoticon')
    await mkdir(join(cacheRoot, 'Persist', 'ab'), { recursive: true })
    await mkdir(join(cacheRoot, 'Thumb', 'ab'), { recursive: true })
    await writeFile(join(cacheRoot, 'Persist', 'ab', md5), 'synthetic persist')
    await writeFile(join(cacheRoot, 'Thumb', 'ab', `${md5}.thumb`), 'synthetic thumb')

    const resolved = await resolveWechat4EmoticonCache(account!.id, md5, root)
    expect(resolved.persistPath).toBe(join(cacheRoot, 'Persist', 'ab', md5))
    expect(resolved.thumbPath).toBe(join(cacheRoot, 'Thumb', 'ab', `${md5}.thumb`))

    await expect(resolveWechat4EmoticonCache(account!.id, '../not-an-md5', root)).rejects.toThrow(
      /identifier/i,
    )
  })

  it('resolves only catalog-named official pack containers without exposing them in discovery', async () => {
    const { root } = await fixtureRoot()
    const [account] = (await discoverWechat4(root)).accounts
    const packageId = '10000000000000000000000000000001'
    const containerName = '26f42cefcd90010f2cb017a1df7a5b8e'
    const storeRoot = join(
      root,
      'wxid_synthetic_account_abcd',
      'business',
      'emoticon',
      'PersistStore',
      '26',
    )
    await mkdir(storeRoot, { recursive: true })
    await writeFile(join(storeRoot, containerName), 'synthetic official container')
    await writeFile(join(storeRoot, '00000000000000000000000000000000'), 'unrelated container')

    const resolved = await resolveWechat4StoreLayout(account!.id, [packageId], root)
    expect(resolved.accountDirectoryName).toBe('wxid_synthetic_account_abcd')
    expect(resolved.containers).toEqual(new Map([[packageId, join(storeRoot, containerName)]]))
    expect(JSON.stringify(await discoverWechat4(root))).not.toContain('PersistStore')
  })
})
