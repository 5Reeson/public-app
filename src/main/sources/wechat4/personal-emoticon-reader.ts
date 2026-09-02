import {
  clearCandidateDatabaseKey,
  encodeSyntheticCandidateFrame,
  type CandidateDatabaseKey,
} from './candidate-key-pipe.js'
import type { Wechat4HelperErrorCode } from './helper-protocol.js'
import {
  runWechat4HelperForPersonalEmoticons,
  type Wechat4HelperRunnerOptions,
} from './helper-runner.js'
import type { Wechat4PersonalEmoticon } from './personal-emoticon-catalog.js'
import type { Wechat4Snapshot } from './wechat4-layout.js'

export interface Wechat4PersonalEmoticonReadRequest {
  accountId: string
  snapshot: Wechat4Snapshot
  signal?: AbortSignal
  /** Re-run the explicitly authorized live Gate G flow instead of using a cached candidate. */
  forceAcquire?: boolean
}

export interface Wechat4PersonalEmoticonReader {
  read(request: Wechat4PersonalEmoticonReadRequest): Promise<Wechat4PersonalEmoticon[]>
}

export interface Wechat4CandidateStore {
  load(accountId: string): Promise<CandidateDatabaseKey | undefined>
  save(accountId: string, candidate: CandidateDatabaseKey): Promise<void>
  clear(accountId: string): Promise<void>
}

/**
 * Production wiring must invoke the already validated Gate G temporary-copy acquisition and return
 * its one-shot candidate in memory. Implementations must never use argv/env/stdout or logging.
 */
export type AcquireWechat4Candidate = (
  request: Wechat4PersonalEmoticonReadRequest,
) => Promise<CandidateDatabaseKey>

class HelperResponseError extends Error {
  constructor(readonly code: Wechat4HelperErrorCode) {
    super('微信 4.x 表情数据库读取失败')
    this.name = 'HelperResponseError'
  }
}

export interface HelperWechat4PersonalEmoticonReaderOptions {
  helper: Wechat4HelperRunnerOptions
  candidateStore: Wechat4CandidateStore
  acquireCandidate: AcquireWechat4Candidate
}

export class HelperWechat4PersonalEmoticonReader implements Wechat4PersonalEmoticonReader {
  constructor(private readonly options: HelperWechat4PersonalEmoticonReaderOptions) {}

  private async readWithCandidate(
    request: Wechat4PersonalEmoticonReadRequest,
    candidate: CandidateDatabaseKey,
  ): Promise<Wechat4PersonalEmoticon[]> {
    try {
      request.signal?.throwIfAborted()
      const frame = encodeSyntheticCandidateFrame(candidate)
      const result = await runWechat4HelperForPersonalEmoticons(
        {
          v: 1,
          id: `personal-emoticons-${Date.now()}`,
          method: 'personalEmoticonsFd',
          params: { databasePath: request.snapshot.databasePath },
        },
        frame,
        {
          ...this.options.helper,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      )
      if (!result.response.ok) throw new HelperResponseError(result.response.error.code)
      const expected = result.response.result.recordCount
      const favoriteCount = result.response.result.favoriteCount
      const customCount = result.response.result.customCount
      if (
        !Number.isSafeInteger(expected) ||
        !Number.isSafeInteger(favoriteCount) ||
        !Number.isSafeInteger(customCount) ||
        (favoriteCount as number) < 0 ||
        (customCount as number) < 0 ||
        (favoriteCount as number) + (customCount as number) !== expected ||
        expected !== result.records.length
      ) {
        throw new Error('WeChat 4 helper returned an inconsistent catalog count')
      }
      return result.records
    } finally {
      clearCandidateDatabaseKey(candidate)
    }
  }

  async read(request: Wechat4PersonalEmoticonReadRequest): Promise<Wechat4PersonalEmoticon[]> {
    if (request.forceAcquire) await this.options.candidateStore.clear(request.accountId)
    const cached = request.forceAcquire
      ? undefined
      : await this.options.candidateStore.load(request.accountId)
    if (cached) {
      try {
        return await this.readWithCandidate(request, cached)
      } catch (error) {
        if (!(error instanceof HelperResponseError) || error.code !== 'KEY_VALIDATION_FAILED') {
          throw error
        }
        await this.options.candidateStore.clear(request.accountId)
      }
    }

    const acquired = await this.options.acquireCandidate(request)
    const candidateForStore: CandidateDatabaseKey = {
      role: 'emoticon',
      salt: Buffer.from(acquired.salt),
      key: Buffer.from(acquired.key),
    }
    try {
      const records = await this.readWithCandidate(request, acquired)
      await this.options.candidateStore.save(request.accountId, candidateForStore)
      return records
    } finally {
      clearCandidateDatabaseKey(candidateForStore)
    }
  }
}
