import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assertWechat4NativeArtifacts } from '../../src/main/sources/wechat4/native-runtime.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('WeChat 4 native runtime artifacts', () => {
  it('requires both artifacts to be regular executable files', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wechat4-native-runtime-'))
    cleanup.push(parent)
    const helperPath = join(parent, 'helper')
    const interposerPath = join(parent, 'interposer.dylib')
    await Promise.all([writeFile(helperPath, 'helper'), writeFile(interposerPath, 'interposer')])
    await Promise.all([chmod(helperPath, 0o700), chmod(interposerPath, 0o700)])

    await expect(
      assertWechat4NativeArtifacts({ helperPath, interposerPath }),
    ).resolves.toBeUndefined()

    await chmod(interposerPath, 0o600)
    await expect(assertWechat4NativeArtifacts({ helperPath, interposerPath })).rejects.toThrow(
      'interposer is not a regular executable file',
    )
  })

  it('rejects a symlink even when its target is executable', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wechat4-native-symlink-'))
    cleanup.push(parent)
    const targetPath = join(parent, 'target')
    const helperPath = join(parent, 'helper-link')
    const interposerPath = join(parent, 'interposer.dylib')
    await Promise.all([writeFile(targetPath, 'helper'), writeFile(interposerPath, 'interposer')])
    await Promise.all([chmod(targetPath, 0o700), chmod(interposerPath, 0o700)])
    await symlink(targetPath, helperPath)

    await expect(assertWechat4NativeArtifacts({ helperPath, interposerPath })).rejects.toThrow(
      'helper is not a regular executable file',
    )
  })

  it('keeps the public Community build independent from private native sources', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const [base, community] = await Promise.all([
      readFile(join(process.cwd(), 'build', 'electron-builder.base.yml'), 'utf8'),
      readFile(join(process.cwd(), 'build', 'electron-builder.community.yml'), 'utf8'),
    ])

    expect(packageJson.scripts['package:mac:official']).toBeUndefined()
    expect(packageJson.scripts['package:mac:community']).not.toContain('native:build')
    expect(base).not.toContain('vx-plugin')
    expect(community).toContain('release/community')
    expect(community).not.toContain('extraResources')
    await expect(
      readFile(join(process.cwd(), 'build', 'electron-builder.official.yml'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
