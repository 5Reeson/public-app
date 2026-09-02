import { chmod, cp, lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const SESSION_PREFIX = 'cn-memes-wechat4-app-'

async function assertDirectoryWithoutSymlink(path: string, label: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a directory and not a symbolic link`)
  }
}

async function assertRegularFileWithoutSymlink(path: string, label: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file and not a symbolic link`)
  }
}

async function assertAppBundle(path: string): Promise<void> {
  await assertDirectoryWithoutSymlink(path, 'WeChat app bundle')
  await Promise.all([
    assertRegularFileWithoutSymlink(join(path, 'Contents', 'Info.plist'), 'WeChat Info.plist'),
    assertRegularFileWithoutSymlink(
      join(path, 'Contents', 'MacOS', 'WeChat'),
      'WeChat main executable',
    ),
  ])
}

export interface TemporaryWechatAppCopyOptions {
  sourceAppPath?: string
  temporaryParent?: string
}

/**
 * Session-scoped copy boundary for a WeChat app bundle.
 *
 * This class only copies and cleans. It never signs, launches, injects, or edits the source bundle.
 * The containing directory is private even though the copied app retains its original modes.
 */
export class TemporaryWechatAppCopy {
  readonly appPath: string
  readonly sessionRoot: string

  private cleaned = false
  private readonly expectedParent: string

  private constructor(sessionRoot: string, expectedParent: string) {
    this.sessionRoot = sessionRoot
    this.appPath = join(sessionRoot, 'WeChat.app')
    this.expectedParent = expectedParent
  }

  static async create(
    options: TemporaryWechatAppCopyOptions = {},
  ): Promise<TemporaryWechatAppCopy> {
    const sourceAppPath = resolve(options.sourceAppPath ?? '/Applications/WeChat.app')
    const temporaryParent = resolve(options.temporaryParent ?? tmpdir())
    await assertAppBundle(sourceAppPath)

    const sessionRoot = await mkdtemp(join(temporaryParent, SESSION_PREFIX))
    const copy = new TemporaryWechatAppCopy(sessionRoot, temporaryParent)

    try {
      await chmod(sessionRoot, 0o700)
      await cp(sourceAppPath, copy.appPath, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      })
      await assertAppBundle(copy.appPath)
      return copy
    } catch (error) {
      await copy.cleanup()
      throw error
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return
    const resolvedRoot = resolve(this.sessionRoot)
    if (
      dirname(resolvedRoot) !== this.expectedParent ||
      !basename(resolvedRoot).startsWith(SESSION_PREFIX)
    ) {
      throw new Error('Refusing to remove an unexpected temporary app directory')
    }
    await rm(resolvedRoot, { recursive: true, force: true })
    this.cleaned = true
  }
}
