import type { StickerCollection } from '../../shared/domain.js'

export interface AssetPreviewRecord {
  originalPath: string
  mimeType: string
}

export class AssetPreviewIndex {
  private readonly records = new Map<string, AssetPreviewRecord>()
  private load: Promise<void> | null = null
  private ready = false

  update(collection: StickerCollection): void {
    this.records.clear()
    for (const asset of collection.assets) {
      this.records.set(asset.id, {
        originalPath: asset.originalPath,
        mimeType: asset.mimeType,
      })
    }
    this.ready = true
  }

  async find(
    assetId: string,
    loadCollection: () => Promise<StickerCollection>,
  ): Promise<AssetPreviewRecord | undefined> {
    const indexed = this.records.get(assetId)
    if (indexed || this.ready) return indexed
    this.load ??= loadCollection()
      .then((collection) => this.update(collection))
      .finally(() => {
        this.load = null
      })
    await this.load
    return this.records.get(assetId)
  }
}
