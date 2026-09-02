import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, type StickerAppApi } from '../shared/ipc.js'
import type {
  ImportMode,
  ImportProgress,
  LegacyWechatDownloadMode,
  PrepareProgress,
  SendPackProgress,
  WhatsAppConnectionView,
  Wechat4GateStatus,
  WechatDownloadMode,
} from '../shared/domain.js'

const api: StickerAppApi = {
  getCollection: () => ipcRenderer.invoke(IPC_CHANNELS.getCollection),
  getExportTask: () => ipcRenderer.invoke(IPC_CHANNELS.getExportTask),
  saveExportTask: (task) => ipcRenderer.invoke(IPC_CHANNELS.saveExportTask, task),
  resetExportTask: () => ipcRenderer.invoke(IPC_CHANNELS.resetExportTask),
  getExportDirectory: (directoryId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getExportDirectory, directoryId),
  chooseExportDirectory: (directoryId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseExportDirectory, directoryId),
  getDefaultExportDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.getDefaultExportDirectory),
  chooseDefaultExportDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseDefaultExportDirectory),
  prepareExportTask: () => ipcRenderer.invoke(IPC_CHANNELS.prepareExportTask),
  cancelExportPreparation: () => ipcRenderer.invoke(IPC_CHANNELS.cancelExportPreparation),
  transferLocalExport: () => ipcRenderer.invoke(IPC_CHANNELS.transferLocalExport),
  savePreparedSnapshot: (forceDuplicate?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.savePreparedSnapshot, forceDuplicate),
  listPreparedSnapshots: () => ipcRenderer.invoke(IPC_CHANNELS.listPreparedSnapshots),
  getPreparedSnapshot: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.getPreparedSnapshot, id),
  usePreparedSnapshot: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.usePreparedSnapshot, id),
  deletePreparedSnapshot: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.deletePreparedSnapshot, id),
  importAssets: (mode: ImportMode) => ipcRenderer.invoke(IPC_CHANNELS.importAssets, mode),
  discoverLegacyWechat: () => ipcRenderer.invoke(IPC_CHANNELS.wechatLegacyDiscover),
  getWechatAccountPreview: (accountKind, accountId) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechatPreviewGet, accountKind, accountId),
  previewLegacyWechat: (accountId: string, downloadMode: LegacyWechatDownloadMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechatLegacyPreview, accountId, downloadMode),
  downloadLegacyWechat: (accountId: string, downloadMode: LegacyWechatDownloadMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechatLegacyDownload, accountId, downloadMode),
  importLegacyWechat: (accountId: string, downloadMode: LegacyWechatDownloadMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechatLegacyImport, accountId, downloadMode),
  cancelLegacyWechatImport: () => ipcRenderer.invoke(IPC_CHANNELS.wechatLegacyCancel),
  discoverWechat4: () => ipcRenderer.invoke(IPC_CHANNELS.wechat4Discover),
  previewWechat4: (accountId: string, confirmed: boolean, downloadMode: WechatDownloadMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechat4Preview, accountId, confirmed, downloadMode),
  downloadWechat4: (accountId: string, confirmed: boolean, downloadMode: WechatDownloadMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechat4Download, accountId, confirmed, downloadMode),
  listWechat4OfficialAlbums: (accountId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechat4OfficialAlbums, accountId),
  previewWechat4OfficialAlbum: (accountId: string, packageId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechat4OfficialAlbumPreview, accountId, packageId),
  importWechat4OfficialAlbums: (accountId: string, packageIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechat4OfficialAlbumsImport, accountId, packageIds),
  commitWechatStagedImport: (accountKind, accountId, selectedAssetIds) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.wechatStagedImportCommit,
      accountKind,
      accountId,
      selectedAssetIds,
    ),
  importWechat4: (accountId: string, confirmed: boolean, downloadMode: WechatDownloadMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechat4Import, accountId, confirmed, downloadMode),
  cancelWechat4Import: () => ipcRenderer.invoke(IPC_CHANNELS.wechat4Cancel),
  confirmWechat4FavoritesReady: () => ipcRenderer.invoke(IPC_CHANNELS.wechat4FavoritesReady),
  getVxPluginCapability: () => ipcRenderer.invoke(IPC_CHANNELS.vxPluginGetCapability),
  refreshVxPluginCapability: () => ipcRenderer.invoke(IPC_CHANNELS.vxPluginRefresh),
  openVxPluginInstallPage: () => ipcRenderer.invoke(IPC_CHANNELS.vxPluginOpenInstallPage),
  getVxPluginDistributionAvailability: () =>
    ipcRenderer.invoke(IPC_CHANNELS.vxPluginGetDistributionAvailability),
  installVxPluginFromRemote: () => ipcRenderer.invoke(IPC_CHANNELS.vxPluginInstallRemote),
  chooseVxPluginPackage: () => ipcRenderer.invoke(IPC_CHANNELS.vxPluginChoosePackage),
  getAppUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.appUpdateGetState),
  checkForAppUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.appUpdateCheck),
  openAppUpdateReleasePage: () => ipcRenderer.invoke(IPC_CHANNELS.appUpdateOpenReleasePage),
  reorderAssets: (orderedIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.reorderAssets, orderedIds),
  removeAssets: (assetIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.removeAssets, assetIds),
  setSelection: (selectedIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.setSelection, selectedIds),
  copyAssetImage: (assetId: string) => ipcRenderer.invoke(IPC_CHANNELS.copyAssetImage, assetId),
  updatePackSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updatePackSettings, settings),
  preparePacks: () => ipcRenderer.invoke(IPC_CHANNELS.preparePacks),
  getWhatsAppStatus: () => ipcRenderer.invoke(IPC_CHANNELS.whatsappGetStatus),
  connectWhatsApp: (pairingPhone?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.whatsappConnect, pairingPhone),
  disconnectWhatsApp: () => ipcRenderer.invoke(IPC_CHANNELS.whatsappDisconnect),
  setWhatsAppCredentialMode: (mode) =>
    ipcRenderer.invoke(IPC_CHANNELS.whatsappSetCredentialMode, mode),
  logoutWhatsApp: (confirmed) => ipcRenderer.invoke(IPC_CHANNELS.whatsappLogout, confirmed),
  listWhatsAppGroups: () => ipcRenderer.invoke(IPC_CHANNELS.whatsappListGroups),
  sendWhatsAppPacks: (targetId: string, packIds?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.whatsappSendPacks, targetId, packIds),
  onWhatsAppStatus: (listener: (status: WhatsAppConnectionView) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: WhatsAppConnectionView) =>
      listener(status)
    ipcRenderer.on(IPC_CHANNELS.whatsappStatus, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.whatsappStatus, handler)
  },
  onSendPackProgress: (listener: (progress: SendPackProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: SendPackProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.whatsappSendProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.whatsappSendProgress, handler)
  },
  onPrepareProgress: (listener: (progress: PrepareProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: PrepareProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.prepareProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.prepareProgress, handler)
  },
  onImportProgress: (listener: (progress: ImportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ImportProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.importProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.importProgress, handler)
  },
  onLegacyWechatProgress: (listener: (progress: ImportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ImportProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.wechatLegacyProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.wechatLegacyProgress, handler)
  },
  onWechat4Progress: (listener: (progress: ImportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ImportProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.wechat4Progress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.wechat4Progress, handler)
  },
  onWechat4GateStatus: (listener: (status: Wechat4GateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Wechat4GateStatus) =>
      listener(status)
    ipcRenderer.on(IPC_CHANNELS.wechat4GateStatus, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.wechat4GateStatus, handler)
  },
  onVxPluginInstallProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.vxPluginInstallProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.vxPluginInstallProgress, handler)
  },
  onAppUpdateAvailable: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, update: Parameters<typeof listener>[0]) =>
      listener(update)
    ipcRenderer.on(IPC_CHANNELS.appUpdateAvailable, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.appUpdateAvailable, handler)
  },
}

contextBridge.exposeInMainWorld('stickerApp', Object.freeze(api))
