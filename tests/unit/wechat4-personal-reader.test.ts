import { describe, expect, it, vi } from 'vitest'

const runPersonalEmoticons = vi.hoisted(() => vi.fn())

vi.mock('../../src/main/sources/wechat4/helper-runner.js', () => ({
  runWechat4HelperForPersonalEmoticons: runPersonalEmoticons,
}))

import type { CandidateDatabaseKey } from '../../src/main/sources/wechat4/candidate-key-pipe.js'
import {
  HelperWechat4PersonalEmoticonReader,
  type Wechat4CandidateStore,
} from '../../src/main/sources/wechat4/personal-emoticon-reader.js'

function candidate(saltByte: number, keyByte: number): CandidateDatabaseKey {
  return {
    role: 'emoticon',
    salt: Buffer.alloc(16, saltByte),
    key: Buffer.alloc(32, keyByte),
  }
}

describe('HelperWechat4PersonalEmoticonReader', () => {
  it('evicts only a selected account stale key, reacquires, validates, then caches it', async () => {
    runPersonalEmoticons
      .mockResolvedValueOnce({
        response: {
          v: 1,
          id: 'cached-candidate',
          ok: false,
          error: {
            code: 'KEY_VALIDATION_FAILED',
            message: 'fixed helper error',
            retryable: true,
          },
        },
        records: [],
      })
      .mockResolvedValueOnce({
        response: {
          v: 1,
          id: 'reacquired-candidate',
          ok: true,
          result: { verified: true, recordCount: 0, favoriteCount: 0, customCount: 0 },
        },
        records: [],
      })

    const selectedAccount = 'wechat4-0123456789abcdef'
    const otherAccount = 'wechat4-fedcba9876543210'
    const cached = candidate(0x11, 0x21)
    const acquired = candidate(0x12, 0x22)
    const stored = new Map<string, CandidateDatabaseKey>([
      [selectedAccount, cached],
      [otherAccount, candidate(0x13, 0x23)],
    ])
    const store: Wechat4CandidateStore = {
      load: vi.fn(async (accountId) => stored.get(accountId)),
      save: vi.fn(async (accountId, value) => {
        stored.set(accountId, {
          role: 'emoticon',
          salt: Buffer.from(value.salt),
          key: Buffer.from(value.key),
        })
      }),
      clear: vi.fn(async (accountId) => {
        stored.delete(accountId)
      }),
    }
    const acquireCandidate = vi.fn(async () => acquired)
    const reader = new HelperWechat4PersonalEmoticonReader({
      helper: { executable: '/synthetic/wechat4-helper' },
      candidateStore: store,
      acquireCandidate,
    })

    await expect(
      reader.read({
        accountId: selectedAccount,
        snapshot: {
          directory: '/synthetic/snapshot',
          databasePath: '/synthetic/snapshot/emoticon.db',
          sidecars: [],
        },
      }),
    ).resolves.toEqual([])

    expect(runPersonalEmoticons).toHaveBeenCalledTimes(2)
    expect(store.clear).toHaveBeenCalledTimes(1)
    expect(store.clear).toHaveBeenCalledWith(selectedAccount)
    expect(acquireCandidate).toHaveBeenCalledTimes(1)
    expect(stored.get(otherAccount)?.key.equals(Buffer.alloc(32, 0x23))).toBe(true)
    expect(stored.get(selectedAccount)?.key.equals(Buffer.alloc(32, 0x22))).toBe(true)
    expect(cached.key.equals(Buffer.alloc(32))).toBe(true)
    expect(acquired.key.equals(Buffer.alloc(32))).toBe(true)
  })
})
