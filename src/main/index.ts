import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'

import { ExportDestinationStore } from './exports/export-destination-store.js'
import { ExportPreferencesStore } from './exports/export-preferences.js'
import { ExportPreparer, type PreparedExportResult } from './exports/export-preparer.js'
import { writePreparedLocalExport } from './exports/local-export-writer.js'
import { LocalStickerSource } from './library/local-sticker-source.js'
import { ExportTaskStore } from './exports/export-task-store.js'
import {
  PreparedSnapshotStore,
  toPreparedSnapshotSummary,
  toPreparedSnapshotView,
} from './exports/prepared-snapshot-store.js'
import { ImportPreferencesStore } from './library/import-preferences.js'
import { AssetPreviewIndex } from './library/asset-preview-index.js'
import { renderClipboardPng } from './library/clipboard-image.js'
import { ManifestStore } from './library/manifest-store.js'
import { PackPreparer, type PreparedPack } from './packs/pack-preparer.js'
import { WechatLegacySource } from './sources/wechat-legacy/wechat-legacy-source.js'
import {
  WechatImportStageStore,
  type WechatImportStageScope,
} from './sources/wechat-import-stage-store.js'
import { Wechat4GateGAcquirer } from './sources/wechat4/gate-g-acquirer.js'
import { VxPluginManager } from './plugins/vx-plugin-capability.js'
import { VxPluginInstaller } from './plugins/vx-plugin-installer.js'
import {
  AppUpdateService,
  readBuildFlavor,
  shouldCheckForUpdatesAutomatically,
} from './updates/app-update-service.js'
import {
  createProductWechat4StickerSource,
  type Wechat4StickerSource,
} from './sources/wechat4/wechat4-source.js'
import { EncryptedAuthStore } from './whatsapp/encrypted-auth-store.js'
import { CredentialAuthStore } from './whatsapp/credential-auth-store.js'
import { CredentialModeStore, isCredentialMode } from './whatsapp/credential-mode-store.js'
import { PlaintextAuthStore } from './whatsapp/plaintext-auth-store.js'
import { SendReceiptStore } from './whatsapp/send-receipt-store.js'
import { WhatsAppManager } from './whatsapp/whatsapp-manager.js'
import type {
  CollectionView,
  ExportTask,
  ExportTaskDraft,
  ImportMode,
  ImportSummary,
  PackSettings,
  PrepareExportSummary,
  PreparedPackView,
  PreparedSnapshotView,
  StickerCollection,
  UsePreparedSnapshotResult,
  Wechat4GateStatus,
  Wechat4ImportDiscoveryView,
  Wechat4OfficialAlbumListResult,
  WechatAccountKind,
  WechatAccountPreviewResult,
  WechatAccountPreviewView,
  WechatDownloadMode,
  WechatStagedImportView,
  WechatStageDownloadResult,
} from '../shared/domain.js'
import { IPC_CHANNELS } from '../shared/ipc.js'
import type { VxPluginCapability, VxPluginInstallProgress } from '../shared/vx-plugin.js'
import { VX_PLUGIN_DISTRIBUTION_CONFIG } from '../shared/vx-plugin-distribution-config.js'
import { APP_UPDATE_CONFIG } from '../shared/app-update-config.js'
import type { AppUpdateCheckResult, AppUpdateInfo } from '../shared/app-update.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sticker-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: 'sticker-snapshot',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: 'sticker-wechat',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

let mainWindow: BrowserWindow | null = null
let manifestStore: ManifestStore
let exportTaskStore: ExportTaskStore
let exportDestinationStore: ExportDestinationStore
let exportPreferences: ExportPreferencesStore
let preparedSnapshotStore: PreparedSnapshotStore
let collectionDirectory: string
let importPreferences: ImportPreferencesStore
let whatsappManager: WhatsAppManager
let wechat4Source: Wechat4StickerSource | undefined
let vxPluginManager: VxPluginManager
let vxPluginInstaller: VxPluginInstaller
let appUpdateService: AppUpdateService
let wechat4KeyStoreDirectory: string
let wechatImportStageStore: WechatImportStageStore
const assetPreviewIndex = new AssetPreviewIndex()
const localSource = new LocalStickerSource()
const legacyWechatSource = new WechatLegacySource()
const packPreparer = new PackPreparer()
const exportPreparer = new ExportPreparer(packPreparer)
let mutationQueue: Promise<unknown> = Promise.resolve()
let exportPreparationController: AbortController | null = null
let exportPreparationTask: Promise<{ task: ExportTask; prepared: PreparedExportResult }> | null =
  null
let legacyWechatImportController: AbortController | null = null
let wechat4ImportController: AbortController | null = null
let wechat4ImportTask: Promise<unknown> | null = null
let allowQuitAfterWechat4Cleanup = false
let resolveWechat4FavoritesReady: (() => void) | null = null

function requireWechat4Source(): Wechat4StickerSource {
  if (!wechat4Source) {
    throw new Error('新版微信导入组件尚未就绪，请安装或更新组件后重新检测。')
  }
  return wechat4Source
}

async function refreshVxPluginRuntime(): Promise<VxPluginCapability> {
  const capability = await vxPluginManager.refresh()
  wechat4Source = undefined
  const plugin = vxPluginManager.getReadyPlugin()
  if (!plugin) return capability

  const wechat4Acquirer = new Wechat4GateGAcquirer({
    artifacts: plugin.artifacts,
    candidateTimeoutMs: 10 * 60_000,
    onStatus: sendWechat4GateStatus,
    waitForFavoritesReady: waitForWechat4FavoritesReady,
  })
  wechat4Source = createProductWechat4StickerSource({
    helper: { executable: plugin.artifacts.helperPath, timeoutMs: 90_000 },
    keyStoreDirectory: wechat4KeyStoreDirectory,
    acquireCandidate: (request) => wechat4Acquirer.acquire(request),
  })
  return capability
}

function waitForWechat4FavoritesReady(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (resolveWechat4FavoritesReady) {
    return Promise.reject(new Error('微信收藏表情确认已在等待中'))
  }
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort)
      resolveWechat4FavoritesReady = null
      resolve()
    }
    const onAbort = () => {
      resolveWechat4FavoritesReady = null
      reject(signal?.reason ?? new DOMException('WeChat 4 import stopped', 'AbortError'))
    }
    resolveWechat4FavoritesReady = finish
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function sendWechat4GateStatus(status: Wechat4GateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.wechat4GateStatus, status)
  }
}

function sendVxPluginInstallProgress(progress: VxPluginInstallProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.vxPluginInstallProgress, progress)
  }
}

function sendAppUpdateAvailable(update: AppUpdateInfo): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.appUpdateAvailable, update)
  }
}

function announceAvailableUpdate(result: AppUpdateCheckResult | undefined): void {
  if (result?.status === 'available') sendAppUpdateAvailable(result.update)
}

function sanitizeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(message.replaceAll(app.getPath('home'), '<home>'))
}

function previewUrl(assetId: string, sha256: string): string {
  return `sticker-asset://preview/${encodeURIComponent(assetId)}?v=${sha256.slice(0, 12)}`
}

function snapshotPreviewUrl(snapshotId: string, payloadId: string): string {
  return `sticker-snapshot://preview/${encodeURIComponent(snapshotId)}/${encodeURIComponent(payloadId)}`
}

function wechatStagePreviewUrl(
  scope: WechatImportStageScope,
  accountKind: WechatAccountKind,
  accountId: string,
  assetId: string,
  sha256: string,
): string {
  return `sticker-wechat://preview/${scope}/${accountKind}/${encodeURIComponent(accountId)}/${encodeURIComponent(assetId)}?v=${sha256.slice(0, 12)}`
}

function toWechatAccountPreviewView(
  accountKind: WechatAccountKind,
  accountId: string,
  collection: StickerCollection,
  scope: WechatImportStageScope = 'preview',
): WechatAccountPreviewView {
  return {
    accountKind,
    accountId,
    updatedAt: collection.updatedAt,
    assets: collection.assets.map(({ originalPath: _originalPath, ...asset }) => ({
      ...asset,
      previewUrl: wechatStagePreviewUrl(scope, accountKind, accountId, asset.id, asset.sha256),
    })),
  }
}

function toWechatStagedImportView(
  accountKind: WechatAccountKind,
  accountId: string,
  collection: StickerCollection,
): WechatStagedImportView {
  return {
    accountKind,
    accountId,
    updatedAt: collection.updatedAt,
    assets: collection.assets.map(({ originalPath: _originalPath, ...asset }) => ({
      ...asset,
      previewUrl: wechatStagePreviewUrl('download', accountKind, accountId, asset.id, asset.sha256),
    })),
  }
}

function toCollectionView(collection: StickerCollection): CollectionView {
  assetPreviewIndex.update(collection)
  return {
    ...collection,
    assets: collection.assets.map(({ originalPath: _originalPath, ...asset }) => ({
      ...asset,
      previewUrl: previewUrl(asset.id, asset.sha256),
    })),
  }
}

function applyImportResultAssets(
  collection: StickerCollection,
  result: { assets: StickerCollection['assets']; sourceUpdates: StickerCollection['assets'] },
): StickerCollection['assets'] {
  const updates = new Map(result.sourceUpdates.map((asset) => [asset.id, asset]))
  return [...collection.assets.map((asset) => updates.get(asset.id) ?? asset), ...result.assets]
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(operation, operation)
  mutationQueue = next.catch(() => undefined)
  return next
}

async function normalizeExportTaskDraft(draft: ExportTaskDraft): Promise<ExportTaskDraft> {
  const collection = await manifestStore.loadOrCreate()
  const knownIds = new Set(collection.assets.map((asset) => asset.id))
  if (
    draft.selectedAssetIds.some((id) => !knownIds.has(id)) ||
    draft.orderedAssetIds.some((id) => !knownIds.has(id))
  ) {
    throw new TypeError('Export task contains an unknown library asset')
  }
  if (draft.destination?.kind !== 'local-folder') return draft
  if (!draft.destination.directoryId) {
    return { ...draft, destination: { kind: 'local-folder' } }
  }
  const destination = await exportDestinationStore.getChoice(draft.destination.directoryId)
  if (!destination) throw new TypeError('Export directory reference is invalid')
  return { ...draft, destination }
}

async function loadReconciledExportTask(): Promise<ExportTask> {
  const collection = await manifestStore.loadOrCreate()
  return exportTaskStore.reconcileAssets(new Set(collection.assets.map((asset) => asset.id)))
}

async function prepareCurrentExportTask(
  onProgress?: Parameters<ExportPreparer['prepare']>[3],
  signal?: AbortSignal,
): Promise<{ task: ExportTask; prepared: PreparedExportResult }> {
  signal?.throwIfAborted()
  const collection = await manifestStore.loadOrCreate()
  const task = await exportTaskStore.reconcileAssets(
    new Set(collection.assets.map((asset) => asset.id)),
  )
  if (task.destination?.kind === 'local-folder') {
    if (!task.destination.directoryId) throw new Error('请先选择本地导出位置')
    await exportDestinationStore.resolveDirectory(task.destination.directoryId)
  }
  const prepared = await exportPreparer.prepare(
    task,
    collection,
    collectionDirectory,
    onProgress,
    signal,
  )
  signal?.throwIfAborted()
  const hasFailure =
    prepared.warnings.length > 0 ||
    prepared.assetFailures.length > 0 ||
    prepared.groups.some((group) => group.status === 'failed')
  const nextTask = await enqueueMutation(async () => {
    signal?.throwIfAborted()
    const current = await exportTaskStore.loadOrCreate()
    if (current.updatedAt !== task.updatedAt) {
      throw new DOMException('导出任务已修改，已停止旧的准备任务。', 'AbortError')
    }
    return exportTaskStore.setPrepared({
      fingerprint: prepared.fingerprint,
      status: hasFailure ? 'partial-failure' : 'prepared',
      ...(task.prepared?.fingerprint === prepared.fingerprint && task.prepared.snapshotId
        ? { snapshotId: task.prepared.snapshotId }
        : {}),
      preparedAt: new Date().toISOString(),
    })
  })
  return { task: nextTask, prepared }
}

function cancelExportPreparation(message = '已停止准备传输。'): boolean {
  const controller = exportPreparationController
  if (!controller || controller.signal.aborted) return false
  controller.abort(new DOMException(message, 'AbortError'))
  return true
}

async function waitForExportPreparation(): Promise<void> {
  await exportPreparationTask?.catch(() => undefined)
}

/**
 * Rebuilds the renderer preview of a saved snapshot. Snapshots only persist the
 * successfully prepared subset, so failures and warnings are empty.
 */
function snapshotToSummary(view: PreparedSnapshotView): PrepareExportSummary {
  return {
    fingerprint: view.contentFingerprint,
    destination: view.destination,
    name: view.name,
    ...(view.publisher === undefined ? {} : { publisher: view.publisher }),
    groups: view.groups.map((group) => ({ ...group, status: 'prepared' as const })),
    warnings: [],
    animationRepairs: view.groups.flatMap((group) =>
      group.items
        .filter((item) => item.animationTimingAdjusted)
        .map((item) => ({ assetId: item.assetId, droppedFrameCount: item.droppedFrameCount ?? 0 })),
    ),
    assetFailures: [],
  }
}

/**
 * Loads a saved snapshot back into the export workflow as the current prepared
 * result: source, destination, sticker selection and transfer configuration are
 * all fixed by the snapshot, so the flow jumps straight to the final check step.
 */
async function usePreparedSnapshot(id: string): Promise<UsePreparedSnapshotResult> {
  const manifest = await preparedSnapshotStore.get(id)
  return enqueueMutation(async () => {
    const current = await exportTaskStore.loadOrCreate()
    const configuration = manifest.configuration
    const task: ExportTask = {
      ...current,
      source: { kind: 'library', label: '我的表情库' },
      destination:
        configuration.kind === 'whatsapp'
          ? { kind: 'whatsapp' }
          : current.destination?.kind === 'local-folder'
            ? current.destination
            : { kind: 'local-folder' },
      selectedAssetIds: [...manifest.orderedAssetIds],
      orderedAssetIds: [...manifest.orderedAssetIds],
      whatsapp:
        configuration.kind === 'whatsapp'
          ? {
              title: configuration.title,
              publisher: configuration.publisher,
              packSize: configuration.packSize,
            }
          : current.whatsapp,
      localFolder:
        configuration.kind === 'local-folder'
          ? {
              batchName: configuration.batchName,
              format: configuration.format,
              naming: configuration.naming,
              itemsPerFolder: configuration.itemsPerFolder,
            }
          : current.localFolder,
      currentStep: 4,
      prepared: {
        fingerprint: manifest.contentFingerprint,
        status: 'prepared',
        snapshotId: manifest.id,
        preparedAt: new Date().toISOString(),
      },
    }
    const saved = await exportTaskStore.save(task)
    return {
      task: saved,
      summary: snapshotToSummary(toPreparedSnapshotView(manifest, snapshotPreviewUrl)),
    }
  })
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new TypeError(`${label} must be a string array`)
  }
}

function assertPackSettings(value: unknown): asserts value is PackSettings {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid pack settings')
  const settings = value as Partial<PackSettings>
  if (
    typeof settings.title !== 'string' ||
    !settings.title.trim() ||
    settings.title.length > 128 ||
    typeof settings.publisher !== 'string' ||
    !settings.publisher.trim() ||
    settings.publisher.length > 128 ||
    !Number.isInteger(settings.packSize) ||
    settings.packSize! < 3 ||
    settings.packSize! > 30
  ) {
    throw new TypeError('Pack settings are invalid')
  }
}

function assertWechatDownloadMode(value: unknown): asserts value is WechatDownloadMode {
  if (value !== 'default' && value !== 'fast' && value !== 'safe') {
    throw new TypeError('Invalid Legacy WeChat download mode')
  }
}

function toPreparedPackView(pack: PreparedPack): PreparedPackView {
  return {
    id: pack.id,
    name: pack.name,
    publisher: pack.publisher,
    mediaKind: pack.mediaKind,
    stickers: pack.stickers.map(({ outputPath: _outputPath, ...sticker }) => sticker),
    traySizeBytes: pack.traySizeBytes,
    assetFailures: pack.assetFailures,
    status: pack.status,
    error: pack.error,
  }
}

async function chooseImportPaths(mode: ImportMode): Promise<string[]> {
  if (mode !== 'files' && mode !== 'directory' && mode !== 'files-or-directory') {
    throw new TypeError('Invalid import mode')
  }
  const acceptsFiles = mode !== 'directory'
  const acceptsDirectories = mode !== 'files'
  const defaultPath = (await importPreferences.getLastImportDirectory()) ?? app.getPath('downloads')
  const result = await dialog.showOpenDialog(mainWindow!, {
    title:
      mode === 'files-or-directory'
        ? '选择贴纸图片或文件夹'
        : mode === 'files'
          ? '选择贴纸图片'
          : '选择包含贴纸图片的文件夹',
    buttonLabel: '导入',
    properties:
      mode === 'files'
        ? ['openFile', 'multiSelections']
        : mode === 'directory'
          ? ['openDirectory']
          : ['openFile', 'openDirectory', 'multiSelections'],
    defaultPath,
    ...(acceptsFiles
      ? {
          filters: [
            { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
            { name: '所有文件', extensions: ['*'] },
          ],
        }
      : {}),
  })
  if (result.canceled || result.filePaths.length === 0) return []

  const firstPath = result.filePaths[0]!
  const firstPathIsDirectory =
    acceptsDirectories && (await stat(firstPath).then((details) => details.isDirectory()))
  const selectedDirectory = firstPathIsDirectory ? firstPath : dirname(firstPath)
  await importPreferences.setLastImportDirectory(selectedDirectory)
  return result.filePaths
}

function installIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.appUpdateGetState, () => appUpdateService.getState())

  ipcMain.handle(IPC_CHANNELS.appUpdateCheck, async () => {
    const result = await appUpdateService.check()
    announceAvailableUpdate(result)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.appUpdateOpenReleasePage, async () => {
    const releasePage = new URL(APP_UPDATE_CONFIG.releasePageUrl)
    if (releasePage.protocol !== 'https:') throw new Error('更新页面必须使用 HTTPS')
    await shell.openExternal(releasePage.href)
  })

  ipcMain.handle(IPC_CHANNELS.vxPluginGetCapability, () => vxPluginManager.getCapability())

  ipcMain.handle(IPC_CHANNELS.vxPluginRefresh, async () => {
    if (wechat4ImportController) {
      throw new Error('新版微信任务运行期间无法重新检测组件。')
    }
    return refreshVxPluginRuntime()
  })

  ipcMain.handle(IPC_CHANNELS.vxPluginOpenInstallPage, async () => {
    const installPageUrl = vxPluginManager.getInstallPageUrl()
    if (!installPageUrl) return false
    await shell.openExternal(installPageUrl)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.vxPluginGetDistributionAvailability, () => ({
    remoteInstall: vxPluginInstaller.getRemoteInstallAvailable(),
  }))

  ipcMain.handle(IPC_CHANNELS.vxPluginInstallRemote, async () => {
    if (wechat4ImportController) throw new Error('新版微信任务运行期间无法安装组件。')
    try {
      return {
        canceled: false,
        capability: await vxPluginInstaller.installFromRemote(),
      }
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.vxPluginChoosePackage, async () => {
    if (wechat4ImportController) throw new Error('新版微信任务运行期间无法安装组件。')
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择微信组件安装包',
      buttonLabel: '验证并安装',
      defaultPath: app.getPath('downloads'),
      properties: ['openFile'],
      filters: [
        { name: '微信组件安装包', extensions: ['zip'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true, capability: vxPluginManager.getCapability() }
    }
    try {
      return {
        canceled: false,
        capability: await vxPluginInstaller.installFromLocalPackage(result.filePaths[0]),
      }
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.getCollection, async () => {
    try {
      return toCollectionView(await manifestStore.loadOrCreate())
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.getExportTask, async () => {
    try {
      return await enqueueMutation(loadReconciledExportTask)
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.saveExportTask, async (_event, task: ExportTaskDraft) => {
    cancelExportPreparation('导出任务已修改，已停止旧的准备任务。')
    try {
      return await enqueueMutation(async () =>
        exportTaskStore.saveDraft(await normalizeExportTaskDraft(task)),
      )
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.resetExportTask, async () => {
    try {
      return await enqueueMutation(() => exportTaskStore.reset())
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.getExportDirectory, async (_event, directoryId: string) => {
    try {
      if (typeof directoryId !== 'string') return undefined
      const [choice, path] = await Promise.all([
        exportDestinationStore.getChoice(directoryId),
        exportDestinationStore.getDirectoryPath(directoryId),
      ])
      return choice?.kind === 'local-folder' && path ? { choice, path } : undefined
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.chooseExportDirectory, async (_event, directoryId: unknown) => {
    try {
      let currentPath: string | undefined
      if (typeof directoryId === 'string') {
        try {
          currentPath = await exportDestinationStore.resolveDirectory(directoryId)
        } catch {
          currentPath = undefined
        }
      }
      const defaultPath =
        currentPath ?? (await exportPreferences.getDefaultDirectory()) ?? app.getPath('downloads')
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '选择本地导出文件夹',
        buttonLabel: '选择',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath,
      })
      if (result.canceled || result.filePaths.length === 0) return undefined
      const choice = await enqueueMutation(() =>
        exportDestinationStore.rememberDirectory(result.filePaths[0]!),
      )
      if (choice.kind !== 'local-folder' || !choice.directoryId) return undefined
      const path = await exportDestinationStore.getDirectoryPath(choice.directoryId)
      return path ? { choice, path } : undefined
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.getDefaultExportDirectory, async () => {
    try {
      const path = await exportPreferences.getDefaultDirectory()
      return path ? { path } : undefined
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.chooseDefaultExportDirectory, async () => {
    try {
      const current = await exportPreferences.getDefaultDirectory()
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '选择默认导出文件夹',
        buttonLabel: '设为默认',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: current ?? app.getPath('downloads'),
      })
      if (result.canceled || result.filePaths.length === 0) return undefined
      const path = await enqueueMutation(() =>
        exportPreferences.setDefaultDirectory(result.filePaths[0]!),
      )
      return { path }
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.prepareExportTask, async (event: IpcMainInvokeEvent) => {
    cancelExportPreparation('已开始新的准备任务。')
    await waitForExportPreparation()
    const controller = new AbortController()
    exportPreparationController = controller
    const preparation = prepareCurrentExportTask((progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.prepareProgress, progress)
      }
    }, controller.signal)
    exportPreparationTask = preparation
    try {
      const { prepared } = await preparation
      return exportPreparer.toSummary(prepared, (assetId) => {
        const payload = prepared.groups
          .flatMap((group) => group.payloads)
          .find((candidate) => candidate.assetId === assetId)
        return payload ? `sticker-asset://preview/${encodeURIComponent(assetId)}` : ''
      })
    } catch (error) {
      throw sanitizeError(error)
    } finally {
      if (exportPreparationController === controller) exportPreparationController = null
      if (exportPreparationTask === preparation) exportPreparationTask = null
    }
  })

  ipcMain.handle(IPC_CHANNELS.cancelExportPreparation, () => cancelExportPreparation())

  ipcMain.handle(IPC_CHANNELS.transferLocalExport, async (event: IpcMainInvokeEvent) => {
    try {
      const { task, prepared } = await prepareCurrentExportTask((progress) =>
        event.sender.send(IPC_CHANNELS.prepareProgress, progress),
      )
      return await enqueueMutation(async () => {
        if (task.destination?.kind !== 'local-folder' || !task.destination.directoryId) {
          throw new Error('请先选择本地导出位置')
        }
        const target = await exportDestinationStore.resolveDirectory(task.destination.directoryId)
        const result = await writePreparedLocalExport(prepared, target)
        await exportTaskStore.setPrepared({
          fingerprint: prepared.fingerprint,
          status: 'complete',
          snapshotId: task.prepared?.snapshotId,
          preparedAt: new Date().toISOString(),
        })
        return result
      })
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.savePreparedSnapshot,
    async (event: IpcMainInvokeEvent, forceDuplicate: unknown) => {
      if (forceDuplicate !== undefined && typeof forceDuplicate !== 'boolean') {
        throw new TypeError('forceDuplicate must be a boolean')
      }
      try {
        const { prepared } = await prepareCurrentExportTask((progress) =>
          event.sender.send(IPC_CHANNELS.prepareProgress, progress),
        )
        return await enqueueMutation(async () => {
          const result = await preparedSnapshotStore.save(prepared, forceDuplicate === true)
          await exportTaskStore.attachSnapshot(prepared.fingerprint, result.manifest.id)
          return {
            kind: result.kind,
            snapshot: toPreparedSnapshotView(result.manifest, snapshotPreviewUrl),
          }
        })
      } catch (error) {
        throw sanitizeError(error)
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.listPreparedSnapshots, async () => {
    try {
      return (await preparedSnapshotStore.list()).map(toPreparedSnapshotSummary)
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.getPreparedSnapshot, async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new TypeError('Invalid snapshot ID')
    try {
      return toPreparedSnapshotView(await preparedSnapshotStore.get(id), snapshotPreviewUrl)
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.usePreparedSnapshot, async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new TypeError('Invalid snapshot ID')
    try {
      return await usePreparedSnapshot(id)
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.deletePreparedSnapshot, async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new TypeError('Invalid snapshot ID')
    try {
      return await enqueueMutation(async () => {
        const deleted = await preparedSnapshotStore.delete(id)
        if (!deleted) return false
        const task = await exportTaskStore.loadOrCreate()
        if (task.prepared?.snapshotId === id) {
          await exportTaskStore.setPrepared({ ...task.prepared, snapshotId: undefined })
        }
        return true
      })
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.importAssets,
    async (event: IpcMainInvokeEvent, mode: ImportMode): Promise<ImportSummary> => {
      try {
        const inputs = await chooseImportPaths(mode)
        if (inputs.length === 0) {
          const collection = await manifestStore.loadOrCreate()
          return {
            canceled: true,
            collection: toCollectionView(collection),
            imported: 0,
            duplicates: 0,
            failures: [],
          }
        }

        return await enqueueMutation(async () => {
          const collection = await manifestStore.loadOrCreate()
          const result = await localSource.importAttributed(
            { collection, collectionDirectory, inputs },
            {
              sourceKind: 'local',
              sourceLabel:
                mode === 'files'
                  ? '本机文件'
                  : mode === 'directory'
                    ? '本机文件夹'
                    : '本机文件或文件夹',
            },
            (progress) => event.sender.send(IPC_CHANNELS.importProgress, progress),
          )
          const next = await manifestStore.save({
            ...collection,
            assets: applyImportResultAssets(collection, result),
            selectedAssetIds: [
              ...collection.selectedAssetIds,
              ...result.assets.map((asset) => asset.id),
            ],
          })
          return {
            canceled: false,
            collection: toCollectionView(next),
            imported: result.assets.length,
            duplicates: result.duplicates.length,
            failures: result.failures,
          }
        })
      } catch (error) {
        throw sanitizeError(error)
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.wechatLegacyDiscover, async () => {
    try {
      return await legacyWechatSource.discover()
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.wechatPreviewGet,
    async (_event, accountKind: unknown, accountId: unknown) => {
      if (accountKind !== 'current' && accountKind !== 'legacy') {
        throw new TypeError('Invalid WeChat account kind')
      }
      if (typeof accountId !== 'string') throw new TypeError('Invalid WeChat account ID')
      try {
        const collection = await wechatImportStageStore.load('preview', accountKind, accountId)
        return collection
          ? toWechatAccountPreviewView(accountKind, accountId, collection)
          : undefined
      } catch (error) {
        throw sanitizeError(error)
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.wechatLegacyPreview,
    async (
      event: IpcMainInvokeEvent,
      accountId: unknown,
      downloadMode: unknown,
    ): Promise<WechatAccountPreviewResult> => {
      if (typeof accountId !== 'string') throw new TypeError('Invalid WeChat account ID')
      assertWechatDownloadMode(downloadMode)
      if (legacyWechatImportController || wechat4ImportController) {
        throw new Error('已有微信导入任务正在运行')
      }
      const controller = new AbortController()
      legacyWechatImportController = controller
      try {
        const staged = await enqueueMutation(() =>
          wechatImportStageStore.replace('preview', 'legacy', accountId, (collection, directory) =>
            legacyWechatSource.import(
              {
                accountId,
                collection,
                collectionDirectory: directory,
                downloadMode,
                maxItems: 5,
                signal: controller.signal,
              },
              (progress) => event.sender.send(IPC_CHANNELS.wechatLegacyProgress, progress),
            ),
          ),
        )
        return {
          canceled: false,
          preview: toWechatAccountPreviewView('legacy', accountId, staged.collection),
        }
      } catch (error) {
        if (controller.signal.aborted) return { canceled: true }
        throw sanitizeError(error)
      } finally {
        if (legacyWechatImportController === controller) legacyWechatImportController = null
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.wechatLegacyDownload,
    async (
      event: IpcMainInvokeEvent,
      accountId: unknown,
      downloadMode: unknown,
    ): Promise<WechatStageDownloadResult> => {
      if (typeof accountId !== 'string') throw new TypeError('Invalid WeChat account ID')
      assertWechatDownloadMode(downloadMode)
      if (legacyWechatImportController || wechat4ImportController) {
        throw new Error('已有微信导入任务正在运行')
      }
      const controller = new AbortController()
      legacyWechatImportController = controller
      try {
        const staged = await enqueueMutation(() =>
          wechatImportStageStore.replace('download', 'legacy', accountId, (collection, directory) =>
            legacyWechatSource.import(
              {
                accountId,
                collection,
                collectionDirectory: directory,
                downloadMode,
                signal: controller.signal,
              },
              (progress) => event.sender.send(IPC_CHANNELS.wechatLegacyProgress, progress),
            ),
          ),
        )
        return {
          canceled: false,
          stagedImport: toWechatStagedImportView('legacy', accountId, staged.collection),
        }
      } catch (error) {
        if (controller.signal.aborted) return { canceled: true }
        throw sanitizeError(error)
      } finally {
        if (legacyWechatImportController === controller) legacyWechatImportController = null
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.wechatLegacyCancel, () => {
    const controller = legacyWechatImportController
    if (!controller || controller.signal.aborted) return false
    controller.abort(new DOMException('Legacy WeChat import stopped', 'AbortError'))
    return true
  })

  ipcMain.handle(
    IPC_CHANNELS.wechatLegacyImport,
    async (
      event: IpcMainInvokeEvent,
      accountId: unknown,
      downloadMode: unknown,
    ): Promise<ImportSummary> => {
      if (typeof accountId !== 'string' || !accountId) throw new TypeError('Invalid account ID')
      assertWechatDownloadMode(downloadMode)
      if (legacyWechatImportController) throw new Error('已有微信导入任务正在运行')
      const controller = new AbortController()
      legacyWechatImportController = controller
      try {
        return await enqueueMutation(async (): Promise<ImportSummary> => {
          const collection = await manifestStore.loadOrCreate()
          let uncommittedOriginalPaths: string[] = []
          try {
            controller.signal.throwIfAborted()
            const result = await legacyWechatSource.import(
              {
                accountId,
                collection,
                collectionDirectory,
                downloadMode,
                signal: controller.signal,
              },
              (progress) => event.sender.send(IPC_CHANNELS.wechatLegacyProgress, progress),
            )
            uncommittedOriginalPaths = result.assets.map((asset) => asset.originalPath)
            controller.signal.throwIfAborted()
            if (legacyWechatImportController === controller) legacyWechatImportController = null
            const next = await manifestStore.save({
              ...collection,
              assets: applyImportResultAssets(collection, result),
              selectedAssetIds: [
                ...collection.selectedAssetIds,
                ...result.assets.map((asset) => asset.id),
              ],
            })
            return {
              canceled: false,
              collection: toCollectionView(next),
              imported: result.assets.length,
              duplicates: result.duplicates.length,
              failures: result.failures,
            }
          } catch (error) {
            if (!controller.signal.aborted) throw error
            await Promise.all(
              uncommittedOriginalPaths.map((originalPath) => rm(originalPath, { force: true })),
            )
            return {
              canceled: true,
              collection: toCollectionView(collection),
              imported: 0,
              duplicates: 0,
              failures: [],
            }
          }
        })
      } catch (error) {
        throw sanitizeError(error)
      } finally {
        if (legacyWechatImportController === controller) legacyWechatImportController = null
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.wechat4Discover, async (): Promise<Wechat4ImportDiscoveryView> => {
    try {
      const source = requireWechat4Source()
      const discovery = await source.discover()
      return {
        rootFound: discovery.rootFound,
        permissionDenied: discovery.permissionDenied,
        accounts: await Promise.all(
          discovery.accounts.map(async ({ id, label, databaseBytes, walPresent, shmPresent }) => ({
            id,
            label,
            databaseBytes,
            walPresent,
            shmPresent,
            authorizationCached: await source.hasCachedAuthorization(id),
          })),
        ),
        failures: discovery.failures.map((failure) => failure.message),
      }
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.wechat4Preview,
    async (
      event: IpcMainInvokeEvent,
      accountId: unknown,
      confirmed: unknown,
      downloadMode: unknown,
    ): Promise<WechatAccountPreviewResult> => {
      if (typeof accountId !== 'string' || !/^wechat4-[a-f0-9]{16}$/.test(accountId)) {
        throw new TypeError('Invalid WeChat 4 account ID')
      }
      if (confirmed !== true) throw new Error('必须先确认微信临时副本授权说明')
      assertWechatDownloadMode(downloadMode)
      if (wechat4ImportController || legacyWechatImportController) {
        throw new Error('已有微信导入任务正在运行')
      }

      const controller = new AbortController()
      wechat4ImportController = controller
      const task = (async (): Promise<WechatAccountPreviewResult> => {
        sendWechat4GateStatus({ phase: 'preparing', message: '正在检查已验证的安全缓存' })
        try {
          const source = requireWechat4Source()
          const sourceLabel = (await source.discover()).accounts.find(
            (account) => account.id === accountId,
          )?.label
          const staged = await enqueueMutation(() =>
            wechatImportStageStore.replace(
              'preview',
              'current',
              accountId,
              (collection, directory) =>
                source.import(
                  {
                    accountId,
                    ...(sourceLabel === undefined ? {} : { sourceLabel }),
                    collection,
                    collectionDirectory: directory,
                    downloadMode,
                    maxItems: 5,
                    signal: controller.signal,
                  },
                  (progress) => {
                    event.sender.send(IPC_CHANNELS.wechat4Progress, progress)
                    sendWechat4GateStatus({
                      phase: progress.phase === 'downloading' ? 'resolving' : 'importing',
                      message:
                        progress.phase === 'downloading' ? '正在解析预览素材' : '正在生成账户预览',
                    })
                  },
                ),
            ),
          )
          sendWechat4GateStatus({ phase: 'complete', message: '账户预览已更新' })
          return {
            canceled: false,
            preview: toWechatAccountPreviewView('current', accountId, staged.collection),
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            sendWechat4GateStatus({ phase: 'failed', message: '账户预览失败' })
            throw sanitizeError(error)
          }
          sendWechat4GateStatus({ phase: 'canceled', message: '账户预览已取消' })
          return { canceled: true }
        } finally {
          resolveWechat4FavoritesReady = null
          if (wechat4ImportController === controller) wechat4ImportController = null
        }
      })()
      wechat4ImportTask = task
      try {
        return await task
      } finally {
        if (wechat4ImportTask === task) wechat4ImportTask = null
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.wechat4Download,
    async (
      event: IpcMainInvokeEvent,
      accountId: unknown,
      confirmed: unknown,
      downloadMode: unknown,
    ): Promise<WechatStageDownloadResult> => {
      if (typeof accountId !== 'string' || !/^wechat4-[a-f0-9]{16}$/.test(accountId)) {
        throw new TypeError('Invalid WeChat 4 account ID')
      }
      if (confirmed !== true) throw new Error('必须先确认微信临时副本授权说明')
      assertWechatDownloadMode(downloadMode)
      if (wechat4ImportController || legacyWechatImportController) {
        throw new Error('已有微信导入任务正在运行')
      }

      const controller = new AbortController()
      wechat4ImportController = controller
      const task = (async (): Promise<WechatStageDownloadResult> => {
        sendWechat4GateStatus({ phase: 'preparing', message: '正在检查已验证的安全缓存' })
        try {
          const source = requireWechat4Source()
          const sourceLabel = (await source.discover()).accounts.find(
            (account) => account.id === accountId,
          )?.label
          const staged = await enqueueMutation(() =>
            wechatImportStageStore.replace(
              'download',
              'current',
              accountId,
              (collection, directory) =>
                source.import(
                  {
                    accountId,
                    ...(sourceLabel === undefined ? {} : { sourceLabel }),
                    collection,
                    collectionDirectory: directory,
                    downloadMode,
                    signal: controller.signal,
                  },
                  (progress) => {
                    event.sender.send(IPC_CHANNELS.wechat4Progress, progress)
                    sendWechat4GateStatus({
                      phase: progress.phase === 'downloading' ? 'resolving' : 'importing',
                      message:
                        progress.phase === 'downloading'
                          ? '正在获取个人收藏表情'
                          : '正在整理个人收藏结果',
                    })
                  },
                ),
            ),
          )
          sendWechat4GateStatus({ phase: 'complete', message: '个人收藏表情下载完成' })
          return {
            canceled: false,
            stagedImport: toWechatStagedImportView('current', accountId, staged.collection),
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            sendWechat4GateStatus({ phase: 'failed', message: '收藏表情下载失败' })
            throw sanitizeError(error)
          }
          sendWechat4GateStatus({ phase: 'canceled', message: '本次下载已取消' })
          return { canceled: true }
        } finally {
          resolveWechat4FavoritesReady = null
          if (wechat4ImportController === controller) wechat4ImportController = null
        }
      })()
      wechat4ImportTask = task
      try {
        return await task
      } finally {
        if (wechat4ImportTask === task) wechat4ImportTask = null
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.wechat4OfficialAlbums,
    async (_event, accountId: unknown): Promise<Wechat4OfficialAlbumListResult> => {
      if (typeof accountId !== 'string' || !/^wechat4-[a-f0-9]{16}$/.test(accountId)) {
        throw new TypeError('Invalid WeChat 4 account ID')
      }
      try {
        const source = requireWechat4Source()
        const [albums, discovery] = await Promise.all([
          source.listOfficialAlbums(accountId),
          source.discover(),
        ])
        const sourceLabel = discovery.accounts.find((account) => account.id === accountId)?.label
        const cachedPackageIds = albums
          .filter((album) => album.cached)
          .map((album) => album.packageId)
        if (cachedPackageIds.length > 0) {
          try {
            const staged = await enqueueMutation(() =>
              wechatImportStageStore.replace(
                'official-covers',
                'current',
                accountId,
                (collection, directory) =>
                  source.importOfficialAlbums({
                    accountId,
                    ...(sourceLabel === undefined ? {} : { sourceLabel }),
                    collection,
                    collectionDirectory: directory,
                    packageIds: cachedPackageIds,
                    maxItemsPerPackage: 1,
                  }),
              ),
            )
            const coverByPackage = new Map<string, (typeof staged.collection.assets)[number]>()
            for (const asset of staged.collection.assets) {
              for (const source of asset.sources) {
                if (source.album?.kind === 'official') coverByPackage.set(source.album.id, asset)
              }
            }
            for (const album of albums) {
              const cover = coverByPackage.get(album.packageId)
              if (!cover) continue
              const { originalPath, ...safeCover } = cover
              if (!originalPath) continue
              album.cover = {
                ...safeCover,
                previewUrl: wechatStagePreviewUrl(
                  'official-covers',
                  'current',
                  accountId,
                  cover.id,
                  cover.sha256,
                ),
              }
            }
          } catch {
            // Album metadata remains usable when an optional cover cannot be staged.
          }
        }
        return { albums, updatedAt: new Date().toISOString() }
      } catch (error) {
        throw sanitizeError(error)
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.wechat4OfficialAlbumPreview,
    async (_event, accountId: unknown, packageId: unknown): Promise<WechatAccountPreviewResult> => {
      if (typeof accountId !== 'string' || !/^wechat4-[a-f0-9]{16}$/.test(accountId)) {
        throw new TypeError('Invalid WeChat 4 account ID')
      }
      if (typeof packageId !== 'string' || !/^[a-z0-9._:-]{1,1024}$/i.test(packageId)) {
        throw new TypeError('Invalid official WeChat package ID')
      }
      try {
        const source = requireWechat4Source()
        const sourceLabel = (await source.discover()).accounts.find(
          (account) => account.id === accountId,
        )?.label
        const staged = await enqueueMutation(() =>
          wechatImportStageStore.replace(
            'official-preview',
            'current',
            accountId,
            (collection, directory) =>
              source.importOfficialAlbums({
                accountId,
                ...(sourceLabel === undefined ? {} : { sourceLabel }),
                collection,
                collectionDirectory: directory,
                packageIds: [packageId],
              }),
          ),
        )
        if (staged.collection.assets.length === 0 && staged.result.failures.length > 0) {
          throw new Error(`专辑预览失败，共 ${staged.result.failures.length} 张素材无法读取`)
        }
        return {
          canceled: false,
          preview: toWechatAccountPreviewView(
            'current',
            accountId,
            staged.collection,
            'official-preview',
          ),
        }
      } catch (error) {
        throw sanitizeError(error)
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.wechat4OfficialAlbumsImport,
    async (
      event: IpcMainInvokeEvent,
      accountId: unknown,
      packageIds: unknown,
    ): Promise<ImportSummary> => {
      if (typeof accountId !== 'string' || !/^wechat4-[a-f0-9]{16}$/.test(accountId)) {
        throw new TypeError('Invalid WeChat 4 account ID')
      }
      assertStringArray(packageIds, 'packageIds')
      if (
        packageIds.length === 0 ||
        new Set(packageIds).size !== packageIds.length ||
        packageIds.some((id) => !/^[a-z0-9._:-]{1,1024}$/i.test(id))
      ) {
        throw new TypeError('Invalid official WeChat package selection')
      }
      if (wechat4ImportController || legacyWechatImportController) {
        throw new Error('已有微信导入任务正在运行')
      }
      const controller = new AbortController()
      wechat4ImportController = controller
      try {
        return await enqueueMutation(async () => {
          const collection = await manifestStore.loadOrCreate()
          const source = requireWechat4Source()
          const sourceLabel = (await source.discover()).accounts.find(
            (account) => account.id === accountId,
          )?.label
          let uncommittedOriginalPaths: string[] = []
          try {
            const result = await source.importOfficialAlbums(
              {
                accountId,
                ...(sourceLabel === undefined ? {} : { sourceLabel }),
                collection,
                collectionDirectory,
                packageIds,
                signal: controller.signal,
              },
              (progress) => event.sender.send(IPC_CHANNELS.wechat4Progress, progress),
            )
            uncommittedOriginalPaths = result.assets.map((asset) => asset.originalPath)
            controller.signal.throwIfAborted()
            if (
              result.assets.length === 0 &&
              result.sourceUpdates.length === 0 &&
              result.failures.length > 0
            ) {
              throw new Error(`所选专辑导入失败，共 ${result.failures.length} 张素材无法读取`)
            }
            const importedIds = [...result.assets, ...result.sourceUpdates].map((asset) => asset.id)
            const next = await manifestStore.save({
              ...collection,
              assets: applyImportResultAssets(collection, result),
              selectedAssetIds: [...new Set([...collection.selectedAssetIds, ...importedIds])],
            })
            return {
              canceled: false,
              collection: toCollectionView(next),
              imported: result.assets.length,
              duplicates: result.duplicates.length,
              failures: result.failures,
              focusedAssetIds: importedIds,
            }
          } catch (error) {
            await Promise.allSettled(
              uncommittedOriginalPaths.map((originalPath) => rm(originalPath, { force: true })),
            )
            throw error
          }
        })
      } catch (error) {
        if (controller.signal.aborted) {
          const collection = await manifestStore.loadOrCreate()
          return {
            canceled: true,
            collection: toCollectionView(collection),
            imported: 0,
            duplicates: 0,
            failures: [],
          }
        }
        throw sanitizeError(error)
      } finally {
        if (wechat4ImportController === controller) wechat4ImportController = null
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.wechat4Cancel, () => {
    const controller = wechat4ImportController
    if (!controller || controller.signal.aborted) return false
    controller.abort(new DOMException('WeChat 4 import stopped', 'AbortError'))
    return true
  })

  ipcMain.handle(IPC_CHANNELS.wechat4FavoritesReady, () => {
    const resolveReady = resolveWechat4FavoritesReady
    if (!resolveReady) return false
    resolveReady()
    return true
  })

  ipcMain.handle(
    IPC_CHANNELS.wechat4Import,
    async (
      event: IpcMainInvokeEvent,
      accountId: unknown,
      confirmed: unknown,
      downloadMode: unknown,
    ): Promise<ImportSummary> => {
      if (typeof accountId !== 'string' || !/^wechat4-[a-f0-9]{16}$/.test(accountId)) {
        throw new TypeError('Invalid WeChat 4 account ID')
      }
      if (confirmed !== true) throw new Error('必须先确认微信临时副本授权说明')
      assertWechatDownloadMode(downloadMode)
      if (wechat4ImportController || legacyWechatImportController) {
        throw new Error('已有微信导入任务正在运行')
      }

      const controller = new AbortController()
      wechat4ImportController = controller
      const task = (async (): Promise<ImportSummary> => {
        sendWechat4GateStatus({ phase: 'preparing', message: '正在检查已验证的安全缓存' })
        try {
          return await enqueueMutation(async (): Promise<ImportSummary> => {
            const collection = await manifestStore.loadOrCreate()
            const source = requireWechat4Source()
            const sourceLabel = (await source.discover()).accounts.find(
              (account) => account.id === accountId,
            )?.label
            let uncommittedOriginalPaths: string[] = []
            try {
              controller.signal.throwIfAborted()
              const result = await source.import(
                {
                  accountId,
                  ...(sourceLabel === undefined ? {} : { sourceLabel }),
                  collection,
                  collectionDirectory,
                  downloadMode,
                  signal: controller.signal,
                },
                (progress) => {
                  event.sender.send(IPC_CHANNELS.wechat4Progress, progress)
                  if (progress.phase === 'downloading') {
                    sendWechat4GateStatus({
                      phase: 'resolving',
                      message: '正在并发解析本地缓存与微信 CDN 素材',
                    })
                  } else if (progress.phase === 'importing') {
                    sendWechat4GateStatus({
                      phase: 'importing',
                      message: '正在验证图片并写入本地素材库',
                    })
                  }
                },
              )
              uncommittedOriginalPaths = result.assets.map((asset) => asset.originalPath)
              controller.signal.throwIfAborted()
              if (wechat4ImportController === controller) wechat4ImportController = null
              const next = await manifestStore.save({
                ...collection,
                assets: applyImportResultAssets(collection, result),
                selectedAssetIds: [
                  ...collection.selectedAssetIds,
                  ...result.assets.map((asset) => asset.id),
                ],
              })
              sendWechat4GateStatus({ phase: 'complete', message: '微信 4.x 收藏表情导入完成' })
              return {
                canceled: false,
                collection: toCollectionView(next),
                imported: result.assets.length,
                duplicates: result.duplicates.length,
                failures: result.failures,
              }
            } catch (error) {
              await Promise.allSettled(
                uncommittedOriginalPaths.map((originalPath) => rm(originalPath, { force: true })),
              )
              if (!controller.signal.aborted) throw error
              sendWechat4GateStatus({ phase: 'canceled', message: '微信 4.x 导入已取消并清理' })
              return {
                canceled: true,
                collection: toCollectionView(collection),
                imported: 0,
                duplicates: 0,
                failures: [],
              }
            }
          })
        } catch (error) {
          sendWechat4GateStatus({ phase: 'failed', message: '微信 4.x 导入失败' })
          throw sanitizeError(error)
        } finally {
          resolveWechat4FavoritesReady = null
          if (wechat4ImportController === controller) wechat4ImportController = null
        }
      })()
      wechat4ImportTask = task
      try {
        return await task
      } finally {
        if (wechat4ImportTask === task) wechat4ImportTask = null
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.wechatStagedImportCommit,
    async (
      event: IpcMainInvokeEvent,
      accountKind: unknown,
      accountId: unknown,
      selectedAssetIds: unknown,
    ): Promise<ImportSummary> => {
      if (accountKind !== 'current' && accountKind !== 'legacy') {
        throw new TypeError('Invalid WeChat account kind')
      }
      if (typeof accountId !== 'string') throw new TypeError('Invalid WeChat account ID')
      assertStringArray(selectedAssetIds, 'selectedAssetIds')
      if (selectedAssetIds.length === 0) throw new Error('请至少选择一张表情')
      if (new Set(selectedAssetIds).size !== selectedAssetIds.length) {
        throw new TypeError('Selected WeChat assets must be unique')
      }

      try {
        return await enqueueMutation(async () => {
          const staged = await wechatImportStageStore.load('download', accountKind, accountId)
          if (!staged) throw new Error('下载结果已失效，请重新选择并下载')
          const stagedById = new Map(staged.assets.map((asset) => [asset.id, asset]))
          if (selectedAssetIds.some((id) => !stagedById.has(id))) {
            throw new TypeError('Selection contains an unknown staged WeChat asset')
          }
          const selectedAssets = selectedAssetIds.map((id) => stagedById.get(id)!)
          const displayNames = new Map(
            selectedAssets.map((asset) => [asset.originalPath, asset.displayName]),
          )
          const albums = new Map(
            selectedAssets.map((asset) => [asset.originalPath, asset.sources[0]?.album]),
          )
          const collection = await manifestStore.loadOrCreate()
          const result = await localSource.importAttributed(
            {
              collection,
              collectionDirectory,
              inputs: selectedAssets.map((asset) => asset.originalPath),
            },
            {
              sourceKind: accountKind === 'current' ? 'wechat4' : 'wechat-legacy',
              sourceAccountId: accountId,
              sourceLabel: selectedAssets[0]?.sources[0]?.label,
              sourceAlbum: (path) => albums.get(path),
              displayName: (path) => displayNames.get(path) ?? '微信表情',
            },
            (progress) =>
              event.sender.send(
                accountKind === 'current'
                  ? IPC_CHANNELS.wechat4Progress
                  : IPC_CHANNELS.wechatLegacyProgress,
                progress,
              ),
          )
          const importedByHash = new Map(
            [...result.assets, ...result.sourceUpdates].map((asset) => [asset.sha256, asset.id]),
          )
          const selectedImportedIds = [
            ...new Set(
              selectedAssets
                .map((asset) => importedByHash.get(asset.sha256))
                .filter((id): id is string => id !== undefined),
            ),
          ]
          const next = await manifestStore.save({
            ...collection,
            assets: applyImportResultAssets(collection, result),
            selectedAssetIds: [
              ...new Set([...collection.selectedAssetIds, ...selectedImportedIds]),
            ],
          })
          return {
            canceled: false,
            collection: toCollectionView(next),
            imported: result.assets.length,
            duplicates: result.duplicates.length,
            failures: result.failures,
            focusedAssetIds: selectedImportedIds,
          }
        })
      } catch (error) {
        throw sanitizeError(error)
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.setSelection, async (_event, selectedIds: unknown) => {
    assertStringArray(selectedIds, 'selectedIds')
    return enqueueMutation(async () => {
      const collection = await manifestStore.loadOrCreate()
      const knownIds = new Set(collection.assets.map((asset) => asset.id))
      const unique = [...new Set(selectedIds)]
      if (unique.some((id) => !knownIds.has(id)))
        throw new TypeError('Selection contains an unknown asset')
      return toCollectionView(await manifestStore.save({ ...collection, selectedAssetIds: unique }))
    })
  })

  ipcMain.handle(IPC_CHANNELS.copyAssetImage, async (_event, assetId: unknown) => {
    if (typeof assetId !== 'string' || !assetId || assetId.length > 256) {
      throw new TypeError('Invalid asset id')
    }
    try {
      const asset = await assetPreviewIndex.find(assetId, () => manifestStore.loadOrCreate())
      if (!asset) throw new Error('找不到要复制的素材。')
      const image = nativeImage.createFromBuffer(await renderClipboardPng(asset.originalPath))
      if (image.isEmpty()) throw new Error('图片无法写入剪贴板。')
      clipboard.writeImage(image)
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.reorderAssets, async (_event, orderedIds: unknown) => {
    assertStringArray(orderedIds, 'orderedIds')
    return enqueueMutation(async () => {
      const collection = await manifestStore.loadOrCreate()
      const byId = new Map(collection.assets.map((asset) => [asset.id, asset]))
      if (
        orderedIds.length !== byId.size ||
        new Set(orderedIds).size !== byId.size ||
        orderedIds.some((id) => !byId.has(id))
      ) {
        throw new TypeError('Reorder must contain every asset exactly once')
      }
      const assets = orderedIds.map((id, userOrder) => ({ ...byId.get(id)!, userOrder }))
      return toCollectionView(await manifestStore.save({ ...collection, assets }))
    })
  })

  ipcMain.handle(IPC_CHANNELS.removeAssets, async (_event, assetIds: unknown) => {
    assertStringArray(assetIds, 'assetIds')
    return enqueueMutation(async () => {
      const collection = await manifestStore.loadOrCreate()
      const removed = new Set(assetIds)
      const assets = collection.assets
        .filter((asset) => !removed.has(asset.id))
        .map((asset, userOrder) => ({ ...asset, userOrder }))
      const selectedAssetIds = collection.selectedAssetIds.filter((id) => !removed.has(id))
      const next = await manifestStore.save({ ...collection, assets, selectedAssetIds })
      await exportTaskStore.reconcileAssets(new Set(assets.map((asset) => asset.id)))
      return toCollectionView(next)
    })
  })

  ipcMain.handle(IPC_CHANNELS.updatePackSettings, async (_event, settings: unknown) => {
    assertPackSettings(settings)
    return enqueueMutation(async () => {
      const collection = await manifestStore.loadOrCreate()
      return toCollectionView(
        await manifestStore.save({
          ...collection,
          title: settings.title.trim(),
          publisher: settings.publisher.trim(),
          packSize: settings.packSize,
        }),
      )
    })
  })

  ipcMain.handle(IPC_CHANNELS.preparePacks, async (event: IpcMainInvokeEvent) => {
    try {
      const collection = await manifestStore.loadOrCreate()
      const packs = await packPreparer.prepare(collection, collectionDirectory, (progress) =>
        event.sender.send(IPC_CHANNELS.prepareProgress, progress),
      )
      return {
        packs: packs.map(toPreparedPackView),
        animationRepairs: packs.flatMap((pack) =>
          pack.stickers
            .filter((sticker) => sticker.animationTimingAdjusted)
            .map((sticker) => ({
              assetId: sticker.assetId,
              droppedFrameCount: sticker.droppedFrameCount ?? 0,
            })),
        ),
      }
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.whatsappGetStatus, () => whatsappManager.getStatus())

  ipcMain.handle(IPC_CHANNELS.whatsappConnect, async (_event, pairingPhone: unknown) => {
    if (pairingPhone !== undefined && typeof pairingPhone !== 'string') {
      throw new TypeError('Pairing phone must be a string')
    }
    try {
      return await whatsappManager.connect(pairingPhone)
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.whatsappDisconnect, async () => {
    try {
      return await whatsappManager.disconnect()
    } catch (error) {
      throw sanitizeError(error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.whatsappSetCredentialMode, async (_event, mode: unknown) => {
    if (!isCredentialMode(mode)) throw new TypeError('Invalid WhatsApp credential mode')
    try {
      return await whatsappManager.setCredentialMode(mode)
    } catch (error) {
      throw sanitizeError(error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.whatsappLogout, async (_event, confirmed: unknown) => {
    if (confirmed !== true) throw new Error('必须确认登出并清除 WhatsApp 登录凭证')
    try {
      return await whatsappManager.logout()
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.whatsappListGroups, async () => {
    try {
      return await whatsappManager.listGroups()
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.whatsappSendPacks,
    async (event: IpcMainInvokeEvent, targetId: unknown, packIds: unknown) => {
      if (typeof targetId !== 'string' || !targetId) throw new TypeError('Invalid WhatsApp target')
      if (packIds !== undefined) assertStringArray(packIds, 'packIds')
      try {
        const collection = await manifestStore.loadOrCreate()
        const task = await exportTaskStore.reconcileAssets(
          new Set(collection.assets.map((asset) => asset.id)),
        )
        const prepared = await exportPreparer.prepareWhatsAppPacks(
          task,
          collection,
          collectionDirectory,
          (progress) => event.sender.send(IPC_CHANNELS.prepareProgress, progress),
        )
        const requestedIds = packIds === undefined ? undefined : new Set(packIds)
        if (requestedIds) {
          const knownIds = new Set(prepared.map((pack) => pack.id))
          if ([...requestedIds].some((id) => !knownIds.has(id))) {
            throw new TypeError('Send request contains an unknown pack')
          }
        }
        const selectedPacks = prepared.filter(
          (pack) => pack.status === 'prepared' && (!requestedIds || requestedIds.has(pack.id)),
        )
        if (selectedPacks.length === 0) throw new Error('没有可发送的贴纸包')
        const receipts = await whatsappManager.sendPacks(targetId, selectedPacks, (progress) =>
          event.sender.send(IPC_CHANNELS.whatsappSendProgress, progress),
        )
        if (task.prepared) {
          await exportTaskStore.setPrepared({
            ...task.prepared,
            status: receipts.some((receipt) => receipt.status === 'failed')
              ? 'partial-failure'
              : 'complete',
          })
        }
        return { receipts }
      } catch (error) {
        throw sanitizeError(error)
      }
    },
  )
}

async function installAssetProtocol(): Promise<void> {
  await protocol.handle('sticker-asset', async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const asset = await assetPreviewIndex.find(id, () => manifestStore.loadOrCreate())
      if (!asset) return new Response('Not found', { status: 404 })
      const body = await readFile(asset.originalPath)
      return new Response(Uint8Array.from(body), {
        headers: {
          'Content-Type': asset.mimeType,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response('Unable to load asset', { status: 404 })
    }
  })
}

async function installSnapshotProtocol(): Promise<void> {
  await protocol.handle('sticker-snapshot', async (request) => {
    try {
      const url = new URL(request.url)
      const [snapshotId, payloadId] = url.pathname
        .replace(/^\//, '')
        .split('/')
        .map(decodeURIComponent)
      if (!snapshotId || !payloadId) return new Response('Not found', { status: 404 })
      const payload = await preparedSnapshotStore.readPayload(snapshotId, payloadId)
      return new Response(Uint8Array.from(payload.contents), {
        headers: {
          'Content-Type': payload.mimeType,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response('Unable to load snapshot payload', { status: 404 })
    }
  })
}

async function installWechatStageProtocol(): Promise<void> {
  await protocol.handle('sticker-wechat', async (request) => {
    try {
      const url = new URL(request.url)
      const [scope, accountKind, encodedAccountId, encodedAssetId] = url.pathname
        .replace(/^\//, '')
        .split('/')
      if (
        scope === undefined ||
        !['preview', 'download', 'official-covers', 'official-preview'].includes(scope) ||
        (accountKind !== 'current' && accountKind !== 'legacy') ||
        !encodedAccountId ||
        !encodedAssetId
      ) {
        return new Response('Not found', { status: 404 })
      }
      const asset = await wechatImportStageStore.findAsset(
        scope as WechatImportStageScope,
        accountKind,
        decodeURIComponent(encodedAccountId),
        decodeURIComponent(encodedAssetId),
      )
      if (!asset) return new Response('Not found', { status: 404 })
      const body = await readFile(asset.originalPath)
      return new Response(Uint8Array.from(body), {
        headers: {
          'Content-Type': asset.mimeType,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response('Unable to load WeChat staged asset', { status: 404 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    show: false,
    title: '图渡',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function scheduleAutomaticUpdateCheck(): Promise<void> {
  const flavor = await readBuildFlavor(app.getAppPath())
  if (!shouldCheckForUpdatesAutomatically(app.isPackaged, flavor)) return
  const timer = setTimeout(() => {
    void appUpdateService.checkAutomaticallyIfDue().then(announceAvailableUpdate)
  }, APP_UPDATE_CONFIG.startupDelayMs)
  timer.unref()
}

app.whenReady().then(async () => {
  const userDataDirectory = app.getPath('userData')
  appUpdateService = new AppUpdateService({
    currentVersion: app.getVersion(),
    latestReleaseApiUrl: APP_UPDATE_CONFIG.latestReleaseApiUrl,
    automaticCheckIntervalMs: APP_UPDATE_CONFIG.automaticCheckIntervalMs,
    requestTimeoutMs: APP_UPDATE_CONFIG.requestTimeoutMs,
    lastCheckPath: join(userDataDirectory, 'settings', 'app-update.json'),
  })
  const configuredInstallPageUrl =
    process.env.VX_PLUGIN_INSTALL_PAGE_URL ?? VX_PLUGIN_DISTRIBUTION_CONFIG.installPageUrl
  wechat4KeyStoreDirectory = join(userDataDirectory, 'wechat4', 'keys')
  vxPluginManager = new VxPluginManager({
    architecture: process.arch,
    roots: [
      join(userDataDirectory, 'plugins', 'vx', 'current'),
      ...(app.isPackaged
        ? [join(process.resourcesPath, 'vx-plugin')]
        : [join(process.cwd(), '.plugin-staging', 'vx')]),
    ],
    ...(configuredInstallPageUrl === undefined
      ? {}
      : { defaultInstallPageUrl: configuredInstallPageUrl }),
  })
  vxPluginInstaller = new VxPluginInstaller({
    architecture: process.arch,
    installRoot: join(userDataDirectory, 'plugins', 'vx'),
    indexUrl: VX_PLUGIN_DISTRIBUTION_CONFIG.indexUrl,
    activate: refreshVxPluginRuntime,
    onProgress: sendVxPluginInstallProgress,
  })
  await refreshVxPluginRuntime()
  collectionDirectory = join(userDataDirectory, 'library', 'collections', 'default')
  manifestStore = new ManifestStore(collectionDirectory)
  wechatImportStageStore = new WechatImportStageStore(
    join(userDataDirectory, 'wechat-imports', 'staged'),
  )
  exportTaskStore = new ExportTaskStore({
    path: join(userDataDirectory, 'exports', 'current-task.json'),
  })
  exportDestinationStore = new ExportDestinationStore({
    path: join(userDataDirectory, 'exports', 'destinations.json'),
  })
  exportPreferences = new ExportPreferencesStore(
    join(userDataDirectory, 'settings', 'export-preferences.json'),
  )
  preparedSnapshotStore = new PreparedSnapshotStore({
    rootDirectory: join(userDataDirectory, 'exports', 'snapshots'),
  })
  importPreferences = new ImportPreferencesStore(
    join(userDataDirectory, 'settings', 'import-preferences.json'),
  )
  whatsappManager = new WhatsAppManager(
    new CredentialAuthStore(
      new CredentialModeStore(join(userDataDirectory, 'whatsapp', 'credential-mode.json')),
      new EncryptedAuthStore(join(userDataDirectory, 'whatsapp', 'session.enc')),
      new PlaintextAuthStore(join(userDataDirectory, 'whatsapp', 'session.json')),
    ),
    new SendReceiptStore(join(userDataDirectory, 'whatsapp', 'send-receipts.json')),
    (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.whatsappStatus, status)
      }
    },
  )
  await whatsappManager.initialize()
  installIpcHandlers()
  await installAssetProtocol()
  await installSnapshotProtocol()
  await installWechatStageProtocol()
  createWindow()
  void scheduleAutomaticUpdateCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (allowQuitAfterWechat4Cleanup || !wechat4ImportTask) return
  event.preventDefault()
  wechat4ImportController?.abort(new DOMException('Application is quitting', 'AbortError'))
  const task = wechat4ImportTask
  void task
    .catch(() => undefined)
    .then(() => {
      if (wechat4ImportTask === task) wechat4ImportTask = null
      allowQuitAfterWechat4Cleanup = true
      app.quit()
    })
})
