export const CURRENT_SCHEMA_VERSION = 2 as const
export const CURRENT_EXPORT_TASK_SCHEMA_VERSION = 2 as const
export const CURRENT_PREPARED_SNAPSHOT_SCHEMA_VERSION = 1 as const

export type StickerSourceKind = 'local' | 'wechat4' | 'wechat-legacy'

export type StickerAlbumKind = 'personal' | 'official'

export interface StickerAlbumRef {
  kind: StickerAlbumKind
  id: string
  name: string
}

/**
 * A safe, user-facing provenance reference. `id` and `accountId` are opaque
 * application identifiers; labels must already be masked before persistence.
 * One asset can retain more than one reference after SHA-256 de-duplication.
 */
export interface StickerAssetSource {
  id: string
  kind: StickerSourceKind
  label: string
  accountId?: string
  importBatchId?: string
  album?: StickerAlbumRef
  importedAt: string
}

export interface StickerAsset {
  id: string
  sources: StickerAssetSource[]
  displayName: string
  originalPath: string
  sha256: string
  mimeType: string
  animated: boolean
  width: number
  height: number
  durationMs?: number
  importedAt: string
  sourceOrder: number
  userOrder: number
}

export interface StickerCollection {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  id: string
  title: string
  publisher: string
  packSize: number
  assets: StickerAsset[]
  selectedAssetIds: string[]
  createdAt: string
  updatedAt: string
}

export type ExportSourceChoice =
  | { kind: 'library'; label: string }
  | { kind: 'local'; label: string; importBatchId?: string }
  | {
      kind: 'wechat4' | 'wechat-legacy'
      label: string
      sourceAccountId: string
    }

export type ExportDestinationChoice =
  { kind: 'whatsapp' } | { kind: 'local-folder'; directoryId?: string; directoryLabel?: string }

export interface ExportDirectoryView {
  choice: Extract<ExportDestinationChoice, { kind: 'local-folder' }>
  path: string
}

export interface DefaultExportDirectoryView {
  path: string
}

export interface WhatsAppTransferSettings {
  title: string
  publisher: string
  packSize: number
}

export interface LocalFolderTransferSettings {
  batchName: string
  format: 'original' | 'converted-webp'
  naming: 'original' | 'sequence'
  itemsPerFolder: number
}

export interface ExportTaskPreparedState {
  fingerprint: string
  status: 'preparing' | 'prepared' | 'partial-failure' | 'complete'
  snapshotId?: string
  preparedAt?: string
}

/**
 * Mutable state for the current export workflow. It is deliberately separate
 * from the library manifest: selection and ordering here never delete assets or
 * change `StickerAsset.userOrder`.
 */
export interface ExportTask {
  schemaVersion: typeof CURRENT_EXPORT_TASK_SCHEMA_VERSION
  id: string
  currentStep: 1 | 2 | 3 | 4
  source?: ExportSourceChoice
  destination?: ExportDestinationChoice
  selectedAssetIds: string[]
  orderedAssetIds: string[]
  whatsapp: WhatsAppTransferSettings
  localFolder: LocalFolderTransferSettings
  prepared?: ExportTaskPreparedState
  createdAt: string
  updatedAt: string
}

/** Renderer-editable fields. Prepared state and identity remain Main-owned. */
export type ExportTaskDraft = Pick<
  ExportTask,
  | 'currentStep'
  | 'source'
  | 'destination'
  | 'selectedAssetIds'
  | 'orderedAssetIds'
  | 'whatsapp'
  | 'localFolder'
>

export type PreparedSnapshotDestination = 'whatsapp' | 'local-folder'

export interface PreparedSnapshotGroup {
  id: string
  name: string
  mediaKind: 'static' | 'animated' | 'mixed'
  assetIds: string[]
  payloads: PreparedSnapshotPayload[]
}

export interface PreparedSnapshotPayload {
  id: string
  role: 'sticker' | 'tray'
  assetId?: string
  fileName: string
  relativePath: string
  sha256: string
  sizeBytes: number
  mimeType: string
  animated: boolean
  durationMs?: number
  animationTimingAdjusted?: boolean
  droppedFrameCount?: number
}

export type PreparedSnapshotConfiguration =
  | ({ kind: 'whatsapp' } & WhatsAppTransferSettings)
  | ({ kind: 'local-folder' } & LocalFolderTransferSettings)

export interface PreparedSnapshotManifest {
  schemaVersion: typeof CURRENT_PREPARED_SNAPSHOT_SCHEMA_VERSION
  id: string
  name: string
  publisher?: string
  destination: PreparedSnapshotDestination
  configuration: PreparedSnapshotConfiguration
  orderedAssetIds: string[]
  groups: PreparedSnapshotGroup[]
  conversionVersion: string
  contentFingerprint: string
  createdAt: string
}

export interface PreparedExportItemView {
  id: string
  assetId: string
  previewUrl: string
  fileName: string
  sizeBytes: number
  animated: boolean
  durationMs?: number
  animationTimingAdjusted?: boolean
  droppedFrameCount?: number
}

export interface PreparedExportGroupView {
  id: string
  name: string
  mediaKind: 'static' | 'animated' | 'mixed'
  assetIds: string[]
  items: PreparedExportItemView[]
  status: 'prepared' | 'failed'
  error?: string
}

export interface PrepareExportSummary {
  fingerprint: string
  destination: PreparedSnapshotDestination
  name: string
  publisher?: string
  groups: PreparedExportGroupView[]
  warnings: string[]
  animationRepairs: AnimationRepairView[]
  assetFailures: PreparedAssetFailure[]
}

export interface LocalExportSummary {
  directoryLabel: string
  groupCount: number
  assetCount: number
}

export interface PreparedSnapshotSummary {
  id: string
  name: string
  publisher?: string
  destination: PreparedSnapshotDestination
  assetCount: number
  groupCount: number
  contentFingerprint: string
  createdAt: string
}

export interface PreparedSnapshotView extends PreparedSnapshotSummary {
  configuration: PreparedSnapshotConfiguration
  orderedAssetIds: string[]
  groups: PreparedExportGroupView[]
  conversionVersion: string
}

export type SavePreparedSnapshotResult =
  | { kind: 'saved'; snapshot: PreparedSnapshotView }
  | { kind: 'duplicate'; snapshot: PreparedSnapshotView }

/** Loading a saved snapshot back into the export workflow as the current prepared result. */
export interface UsePreparedSnapshotResult {
  task: ExportTask
  summary: PrepareExportSummary
}

export interface ImportFailure {
  path: string
  reason: string
}

export interface ImportProgress {
  completed: number
  total: number
  imported: number
  duplicates: number
  failed: number
  phase?: 'downloading' | 'importing'
  currentPath?: string
}

export interface ImportResult {
  assets: StickerAsset[]
  sourceUpdates: StickerAsset[]
  duplicates: string[]
  failures: ImportFailure[]
}

export type ImportMode = 'files' | 'directory' | 'files-or-directory'

export interface ImportSummary {
  canceled: boolean
  collection: CollectionView
  imported: number
  duplicates: number
  failures: ImportFailure[]
  focusedAssetIds?: string[]
}

export interface LegacyWechatAccountView {
  id: string
  label: string
  stickerCount: number
  archiveBytes: number
}

export interface LegacyWechatDiscoveryView {
  rootFound: boolean
  permissionDenied: boolean
  accounts: LegacyWechatAccountView[]
  failures: string[]
}

export interface Wechat4ImportAccountView {
  id: string
  label: string
  databaseBytes: number
  walPresent: boolean
  shmPresent: boolean
  authorizationCached: boolean
}

export interface Wechat4ImportDiscoveryView {
  rootFound: boolean
  permissionDenied: boolean
  accounts: Wechat4ImportAccountView[]
  failures: string[]
}

export type Wechat4GatePhase =
  | 'idle'
  | 'preparing'
  | 'quitting-original'
  | 'copying'
  | 'signing'
  | 'awaiting-qr'
  | 'awaiting-favorites'
  | 'validating'
  | 'resolving'
  | 'importing'
  | 'cleaning'
  | 'complete'
  | 'canceled'
  | 'failed'

export interface Wechat4GateStatus {
  phase: Wechat4GatePhase
  message: string
}

export type WechatDownloadMode = 'default' | 'fast' | 'safe'
export type LegacyWechatDownloadMode = WechatDownloadMode

export type WechatAccountKind = 'current' | 'legacy'

export type WechatStagedAssetView = Omit<StickerAsset, 'originalPath'> & {
  previewUrl: string
}

export interface WechatAccountPreviewView {
  accountKind: WechatAccountKind
  accountId: string
  assets: WechatStagedAssetView[]
  updatedAt: string
}

export interface WechatAccountPreviewResult {
  canceled: boolean
  preview?: WechatAccountPreviewView
}

export interface WechatStagedImportView {
  accountKind: WechatAccountKind
  accountId: string
  assets: WechatStagedAssetView[]
  updatedAt: string
}

export interface WechatStageDownloadResult {
  canceled: boolean
  stagedImport?: WechatStagedImportView
}

export interface Wechat4OfficialAlbumView {
  packageId: string
  name: string
  stickerCount: number
  cached: boolean
  cover?: WechatStagedAssetView
}

export interface Wechat4OfficialAlbumListResult {
  albums: Wechat4OfficialAlbumView[]
  updatedAt: string
}

export interface PackSettings {
  title: string
  publisher: string
  packSize: number
}

export interface PreparedStickerView {
  assetId: string
  sizeBytes: number
  durationMs?: number
  animationTimingAdjusted?: boolean
  droppedFrameCount?: number
}

export interface PreparedAssetFailure {
  assetId: string
  message: string
}

export interface PreparedPackView {
  id: string
  name: string
  publisher: string
  mediaKind: 'static' | 'animated'
  stickers: PreparedStickerView[]
  traySizeBytes: number
  assetFailures: PreparedAssetFailure[]
  status: 'prepared' | 'failed'
  error?: string
}

export interface PreparePacksSummary {
  packs: PreparedPackView[]
  animationRepairs: AnimationRepairView[]
}

export interface AnimationRepairView {
  assetId: string
  droppedFrameCount: number
}

export interface PrepareProgress {
  completed: number
  total: number
  currentName: string
  packIndex: number
  packCount: number
}

export type WhatsAppConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'awaiting-qr'
  | 'awaiting-pairing-code'
  | 'connected'
  | 'reconnecting'
  | 'logged-out'
  | 'error'

export type WhatsAppCredentialMode = 'keychain' | 'plaintext'

export interface WhatsAppTarget {
  id: string
  name: string
  kind: 'self' | 'group'
  participantCount?: number
}

export interface WhatsAppConnectionView {
  phase: WhatsAppConnectionPhase
  hasSession: boolean
  credentialMode: WhatsAppCredentialMode
  canChangeCredentialMode: boolean
  selfTarget?: WhatsAppTarget
  qrDataUrl?: string
  pairingCode?: string
  message?: string
}

export interface SendPackProgress {
  packId: string
  packName: string
  packIndex: number
  packCount: number
  status: 'uploading' | 'sent' | 'failed' | 'skipped'
  message?: string
}

export interface SendPackReceipt {
  packId: string
  packName: string
  status: 'sent' | 'failed' | 'skipped'
  messageId?: string
  error?: string
}

export interface SendPacksSummary {
  receipts: SendPackReceipt[]
}

export interface StickerSource {
  kind: StickerSourceKind
  import(
    request: {
      collection: StickerCollection
      collectionDirectory: string
      inputs: string[]
    },
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportResult>
}

export interface CollectionView extends Omit<StickerCollection, 'assets'> {
  assets: Array<Omit<StickerAsset, 'originalPath'> & { previewUrl: string }>
}
