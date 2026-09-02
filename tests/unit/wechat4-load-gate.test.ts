import { PassThrough } from 'node:stream'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertGateFOperationPaths,
  commonWechatProcesses,
  parseNativeProcessTable,
  processesInsideApp,
  readWechat4Readiness,
  WECHAT4_READINESS_MARKER,
} from '../../src/main/sources/wechat4/load-gate.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('WeChat 4 readiness-only load gate', () => {
  it('accepts only a private copied-app session boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wechat4-load-gate-unit-'))
    temporaryRoots.push(root)
    const original = join(root, 'original', 'WeChat.app')
    const session = join(root, 'session')
    const copied = join(session, 'WeChat.app')
    const probe = join(session, 'probe.dylib')
    await Promise.all([mkdir(original, { recursive: true }), mkdir(copied, { recursive: true })])
    await writeFile(probe, 'synthetic readiness probe')
    await chmod(session, 0o700)

    await expect(
      assertGateFOperationPaths({
        originalAppPath: original,
        sessionRoot: session,
        copiedAppPath: copied,
        probePath: probe,
      }),
    ).resolves.toBeUndefined()

    await expect(
      assertGateFOperationPaths({
        originalAppPath: original,
        sessionRoot: session,
        copiedAppPath: original,
        probePath: probe,
      }),
    ).rejects.toThrow(/refused paths|copied app path/i)
  })

  it('filters processes by the exact copied app boundary', () => {
    const table = parseNativeProcessTable(
      [
        ' 101 101 /private/tmp/session/WeChat.app/Contents/MacOS/WeChat',
        ' 102 777 /private/tmp/session/WeChat.app/Contents/Frameworks/WeChat Helper.app/Contents/MacOS/WeChat Helper',
        ' 103 103 /Applications/WeChat.app/Contents/MacOS/WeChat',
        ' 104 104 /tmp/WeChat',
      ].join('\n'),
    )
    expect(
      processesInsideApp(table, '/private/tmp/session/WeChat.app').map(({ pid }) => pid),
    ).toEqual([101, 102])
    expect(commonWechatProcesses(table).map(({ pid }) => pid)).toEqual([101, 102, 103, 104])
  })

  it('accepts only the fixed readiness marker', async () => {
    const accepted = new PassThrough()
    const acceptedRead = readWechat4Readiness(accepted)
    accepted.end(Buffer.from(WECHAT4_READINESS_MARKER))
    await expect(acceptedRead).resolves.toBeUndefined()

    const rejected = new PassThrough()
    const rejectedRead = readWechat4Readiness(rejected)
    rejected.end(Buffer.alloc(WECHAT4_READINESS_MARKER.length, 0xff))
    await expect(rejectedRead).rejects.toThrow(/invalid/i)
  })
})
