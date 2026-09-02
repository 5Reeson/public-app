import type {
  CollectionView,
  DefaultExportDirectoryView,
  ExportDirectoryView,
  ExportTask,
  ExportTaskDraft,
  ImportMode,
  ImportProgress,
  ImportSummary,
  LegacyWechatDownloadMode,
  LegacyWechatDiscoveryView,
  LocalExportSummary,
  PackSettings,
  PrepareExportSummary,
  PreparePacksSummary,
  PrepareProgress,
  PreparedSnapshotSummary,
  PreparedSnapshotView,
  SavePreparedSnapshotResult,
  SendPackProgress,
  SendPacksSummary,
  UsePreparedSnapshotResult,
  WhatsAppConnectionView,
  WhatsAppCredentialMode,
  WhatsAppTarget,
  Wechat4GateStatus,
  Wechat4ImportDiscoveryView,
  Wechat4OfficialAlbumListResult,
  WechatAccountKind,
  WechatAccountPreviewResult,
  WechatAccountPreviewView,
  WechatDownloadMode,
  WechatStageDownloadResult,
} from './domain.js'
import type {
  VxPluginCapability,
  VxPluginDistributionAvailability,
  VxPluginInstallProgress,
  VxPluginInstallResult,
} from './vx-plugin.js'
import type { AppUpdateCheckResult, AppUpdateInfo, AppUpdateState } from './app-update.js'

export const IPC_CHANNELS = {
  getCollection: 'library:get-collection',
  getExportTask: 'exports:get-current-task',
  saveExportTask: 'exports:save-current-task',
  resetExportTask: 'exports:reset-current-task',
  getExportDirectory: 'exports:get-local-directory',
  chooseExportDirectory: 'exports:choose-local-directory',
  getDefaultExportDirectory: 'settings:get-default-export-directory',
  chooseDefaultExportDirectory: 'settings:choose-default-export-directory',
  prepareExportTask: 'exports:prepare-current-task',
  cancelExportPreparation: 'exports:cancel-preparation',
  transferLocalExport: 'exports:transfer-local',
  savePreparedSnapshot: 'exports:save-prepared-snapshot',
  listPreparedSnapshots: 'exports:list-prepared-snapshots',
  getPreparedSnapshot: 'exports:get-prepared-snapshot',
  usePreparedSnapshot: 'exports:use-prepared-snapshot',
  deletePreparedSnapshot: 'exports:delete-prepared-snapshot',
  importAssets: 'library:import-assets',
  importProgress: 'library:import-progress',
  wechatLegacyDiscover: 'wechat-legacy:discover',
  wechatPreviewGet: 'wechat-preview:get',
  wechatLegacyPreview: 'wechat-legacy:preview',
  wechatLegacyDownload: 'wechat-legacy:download',
  wechatLegacyImport: 'wechat-legacy:import',
  wechatLegacyCancel: 'wechat-legacy:cancel',
  wechatLegacyProgress: 'wechat-legacy:progress',
  wechat4Discover: 'wechat4:discover',
  wechat4Preview: 'wechat4:preview',
  wechat4Download: 'wechat4:download',
  wechat4OfficialAlbums: 'wechat4:official-albums',
  wechat4OfficialAlbumPreview: 'wechat4:official-album-preview',
  wechat4OfficialAlbumsImport: 'wechat4:official-albums-import',
  wechatStagedImportCommit: 'wechat-staged-import:commit',
  wechat4Import: 'wechat4:import',
  wechat4Cancel: 'wechat4:cancel',
  wechat4FavoritesReady: 'wechat4:favorites-ready',
  wechat4Progress: 'wechat4:progress',
  wechat4GateStatus: 'wechat4:gate-status',
  vxPluginGetCapability: 'vx-plugin:get-capability',
  vxPluginRefresh: 'vx-plugin:refresh',
  vxPluginOpenInstallPage: 'vx-plugin:open-install-page',
  vxPluginGetDistributionAvailability: 'vx-plugin:get-distribution-availability',
  vxPluginInstallRemote: 'vx-plugin:install-remote',
  vxPluginChoosePackage: 'vx-plugin:choose-package',
  vxPluginInstallProgress: 'vx-plugin:install-progress',
  appUpdateGetState: 'app-update:get-state',
  appUpdateCheck: 'app-update:check',
  appUpdateOpenReleasePage: 'app-update:open-release-page',
  appUpdateAvailable: 'app-update:available',
  reorderAssets: 'library:reorder-assets',
  removeAssets: 'library:remove-assets',
  setSelection: 'library:set-selection',
  copyAssetImage: 'library:copy-asset-image',
  updatePackSettings: 'packs:update-settings',
  preparePacks: 'packs:prepare',
  prepareProgress: 'packs:prepare-progress',
  whatsappGetStatus: 'whatsapp:get-status',
  whatsappConnect: 'whatsapp:connect',
  whatsappDisconnect: 'whatsapp:disconnect',
  whatsappSetCredentialMode: 'whatsapp:set-credential-mode',
  whatsappLogout: 'whatsapp:logout',
  whatsappListGroups: 'whatsapp:list-groups',
  whatsappSendPacks: 'whatsapp:send-packs',
  whatsappStatus: 'whatsapp:status',
  whatsappSendProgress: 'whatsapp:send-progress',
} as const

export interface StickerAppApi {
  getCollection(): Promise<CollectionView>
  getExportTask(): Promise<ExportTask>
  saveExportTask(task: ExportTaskDraft): Promise<ExportTask>
  resetExportTask(): Promise<ExportTask>
  getExportDirectory(directoryId: string): Promise<ExportDirectoryView | undefined>
  chooseExportDirectory(directoryId?: string): Promise<ExportDirectoryView | undefined>
  getDefaultExportDirectory(): Promise<DefaultExportDirectoryView | undefined>
  chooseDefaultExportDirectory(): Promise<DefaultExportDirectoryView | undefined>
  prepareExportTask(): Promise<PrepareExportSummary>
  cancelExportPreparation(): Promise<boolean>
  transferLocalExport(): Promise<LocalExportSummary>
  savePreparedSnapshot(forceDuplicate?: boolean): Promise<SavePreparedSnapshotResult>
  listPreparedSnapshots(): Promise<PreparedSnapshotSummary[]>
  getPreparedSnapshot(id: string): Promise<PreparedSnapshotView>
  usePreparedSnapshot(id: string): Promise<UsePreparedSnapshotResult>
  deletePreparedSnapshot(id: string): Promise<boolean>
  importAssets(mode: ImportMode): Promise<ImportSummary>
  discoverLegacyWechat(): Promise<LegacyWechatDiscoveryView>
  getWechatAccountPreview(
    accountKind: WechatAccountKind,
    accountId: string,
  ): Promise<WechatAccountPreviewView | undefined>
  previewLegacyWechat(
    accountId: string,
    downloadMode: LegacyWechatDownloadMode,
  ): Promise<WechatAccountPreviewResult>
  downloadLegacyWechat(
    accountId: string,
    downloadMode: LegacyWechatDownloadMode,
  ): Promise<WechatStageDownloadResult>
  importLegacyWechat(
    accountId: string,
    downloadMode: LegacyWechatDownloadMode,
  ): Promise<ImportSummary>
  cancelLegacyWechatImport(): Promise<boolean>
  discoverWechat4(): Promise<Wechat4ImportDiscoveryView>
  previewWechat4(
    accountId: string,
    confirmed: boolean,
    downloadMode: WechatDownloadMode,
  ): Promise<WechatAccountPreviewResult>
  downloadWechat4(
    accountId: string,
    confirmed: boolean,
    downloadMode: WechatDownloadMode,
  ): Promise<WechatStageDownloadResult>
  listWechat4OfficialAlbums(accountId: string): Promise<Wechat4OfficialAlbumListResult>
  previewWechat4OfficialAlbum(
    accountId: string,
    packageId: string,
  ): Promise<WechatAccountPreviewResult>
  importWechat4OfficialAlbums(accountId: string, packageIds: string[]): Promise<ImportSummary>
  commitWechatStagedImport(
    accountKind: WechatAccountKind,
    accountId: string,
    selectedAssetIds: string[],
  ): Promise<ImportSummary>
  importWechat4(
    accountId: string,
    confirmed: boolean,
    downloadMode: WechatDownloadMode,
  ): Promise<ImportSummary>
  cancelWechat4Import(): Promise<boolean>
  confirmWechat4FavoritesReady(): Promise<boolean>
  getVxPluginCapability(): Promise<VxPluginCapability>
  refreshVxPluginCapability(): Promise<VxPluginCapability>
  openVxPluginInstallPage(): Promise<boolean>
  getVxPluginDistributionAvailability(): Promise<VxPluginDistributionAvailability>
  installVxPluginFromRemote(): Promise<VxPluginInstallResult>
  chooseVxPluginPackage(): Promise<VxPluginInstallResult>
  getAppUpdateState(): Promise<AppUpdateState>
  checkForAppUpdate(): Promise<AppUpdateCheckResult>
  openAppUpdateReleasePage(): Promise<void>
  reorderAssets(orderedIds: string[]): Promise<CollectionView>
  removeAssets(assetIds: string[]): Promise<CollectionView>
  setSelection(selectedIds: string[]): Promise<CollectionView>
  copyAssetImage(assetId: string): Promise<void>
  updatePackSettings(settings: PackSettings): Promise<CollectionView>
  preparePacks(): Promise<PreparePacksSummary>
  getWhatsAppStatus(): Promise<WhatsAppConnectionView>
  connectWhatsApp(pairingPhone?: string): Promise<WhatsAppConnectionView>
  disconnectWhatsApp(): Promise<WhatsAppConnectionView>
  setWhatsAppCredentialMode(mode: WhatsAppCredentialMode): Promise<WhatsAppConnectionView>
  logoutWhatsApp(confirmed: boolean): Promise<WhatsAppConnectionView>
  listWhatsAppGroups(): Promise<WhatsAppTarget[]>
  sendWhatsAppPacks(targetId: string, packIds?: string[]): Promise<SendPacksSummary>
  onWhatsAppStatus(listener: (status: WhatsAppConnectionView) => void): () => void
  onSendPackProgress(listener: (progress: SendPackProgress) => void): () => void
  onPrepareProgress(listener: (progress: PrepareProgress) => void): () => void
  onImportProgress(listener: (progress: ImportProgress) => void): () => void
  onLegacyWechatProgress(listener: (progress: ImportProgress) => void): () => void
  onWechat4Progress(listener: (progress: ImportProgress) => void): () => void
  onWechat4GateStatus(listener: (status: Wechat4GateStatus) => void): () => void
  onVxPluginInstallProgress(listener: (progress: VxPluginInstallProgress) => void): () => void
  onAppUpdateAvailable(listener: (update: AppUpdateInfo) => void): () => void
}
