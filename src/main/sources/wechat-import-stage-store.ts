import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import type {
  ImportResult,
  StickerAsset,
  StickerCollection,
  WechatAccountKind,
} from '../../shared/domain.js'
import { createDefaultCollection, ManifestStore } from '../library/manifest-store.js'

export type WechatImportStageScope = 'preview' | 'download' | 'official-covers' | 'official-preview'

const ACCOUNT_IDS: Record<WechatAccountKind, RegExp> = {
  current: /^wechat4-[a-f0-9]{16}$/,
  legacy: /^wechat-legacy-[a-f0-9]{16}$/,
}

function assertAccountId(kind: WechatAccountKind, accountId: string): void {
  if (!ACCOUNT_IDS[kind].test(accountId)) throw new TypeError('Invalid WeChat account ID')
}

function stageKey(kind: WechatAccountKind, accountId: string): string {
  assertAccountId(kind, accountId)
  return `${kind}-${accountId}`
}

function rebaseAsset(asset: StickerAsset, from: string, to: string): StickerAsset {
  const suffix = relative(from, asset.originalPath)
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) {
    throw new Error('Staged WeChat asset escaped its managed directory')
  }
  return { ...asset, originalPath: join(to, suffix) }
}

export class WechatImportStageStore {
  constructor(readonly rootDirectory: string) {}

  directory(scope: WechatImportStageScope, kind: WechatAccountKind, accountId: string): string {
    return join(this.rootDirectory, scope, stageKey(kind, accountId))
  }

  async load(
    scope: WechatImportStageScope,
    kind: WechatAccountKind,
    accountId: string,
  ): Promise<StickerCollection | undefined> {
    const directory = this.directory(scope, kind, accountId)
    const store = new ManifestStore(directory)
    try {
      await access(store.manifestPath)
    } catch {
      return undefined
    }
    return store.load()
  }

  async findAsset(
    scope: WechatImportStageScope,
    kind: WechatAccountKind,
    accountId: string,
    assetId: string,
  ): Promise<StickerAsset | undefined> {
    return (await this.load(scope, kind, accountId))?.assets.find((asset) => asset.id === assetId)
  }

  async replace(
    scope: WechatImportStageScope,
    kind: WechatAccountKind,
    accountId: string,
    importAssets: (
      collection: StickerCollection,
      collectionDirectory: string,
    ) => Promise<ImportResult>,
  ): Promise<{ collection: StickerCollection; result: ImportResult }> {
    const targetDirectory = this.directory(scope, kind, accountId)
    const scopeDirectory = join(this.rootDirectory, scope)
    await mkdir(scopeDirectory, { recursive: true, mode: 0o700 })
    const temporaryDirectory = await mkdtemp(join(scopeDirectory, `.${stageKey(kind, accountId)}-`))
    const seed = createDefaultCollection({
      id: stageKey(kind, accountId),
      title: '微信导入暂存',
      publisher: '图渡',
      packSize: 30,
      assets: [],
      selectedAssetIds: [],
    })

    try {
      const result = await importAssets(seed, temporaryDirectory)
      const assets = result.assets.map((asset) =>
        rebaseAsset(asset, temporaryDirectory, targetDirectory),
      )
      const collection = await new ManifestStore(temporaryDirectory).save({
        ...seed,
        assets,
        selectedAssetIds: assets.map((asset) => asset.id),
      })
      await rm(targetDirectory, { recursive: true, force: true })
      await rename(temporaryDirectory, targetDirectory)
      return {
        collection,
        result: {
          ...result,
          assets,
          sourceUpdates: result.sourceUpdates.map((asset) =>
            rebaseAsset(asset, temporaryDirectory, targetDirectory),
          ),
        },
      }
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      throw error
    }
  }
}
