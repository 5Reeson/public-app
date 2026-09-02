import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/ArrowRight'
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown'
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { EyeIcon as Eye } from '@phosphor-icons/react/Eye'
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/FolderOpen'
import { ImagesIcon as Images } from '@phosphor-icons/react/Images'
import { LinkIcon as Link } from '@phosphor-icons/react/Link'
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/ShieldCheck'
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/WarningCircle'
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/WechatLogo'
import { WhatsappLogoIcon as WhatsappLogo } from '@phosphor-icons/react/WhatsappLogo'
import { XIcon as X } from '@phosphor-icons/react/X'

import type {
  CollectionView,
  DefaultExportDirectoryView,
  ExportDirectoryView,
  ExportTask,
  ExportTaskDraft,
  ImportFailure,
  ImportMode,
  ImportProgress,
  ImportSummary,
  PrepareProgress,
  PrepareExportSummary,
  PreparedPackView,
  PreparedSnapshotView,
  PreparedSnapshotSummary,
  WhatsAppConnectionView,
} from '../../shared/domain.js'
import type {
  AppUpdateCheckResult,
  AppUpdateInfo,
  AppUpdateState,
} from '../../shared/app-update.js'
import { toErrorMessage } from '../../shared/errors.js'
import {
  INITIAL_WHATSAPP_CONNECTION,
  whatsAppConnectionLabel,
} from '../../shared/whatsapp-connection.js'
import { AboutPage } from './components/AboutPage.js'
import { ArchivesPage, SnapshotPreviewDialog } from './components/ArchivesPage.js'
import { AppShell, type AppPage } from './components/AppShell.js'
import { ConnectionsPage } from './components/ConnectionsPage.js'
import { DismissibleInfoNotice } from './components/DismissibleInfoNotice.js'
import { Dialog } from './components/Dialog.js'
import { LibraryPage } from './components/LibraryPage.js'
import { PathDisplay } from './components/PathDisplay.js'
import { ProgressiveImage } from './components/ProgressiveImage.js'
import { ProductBanner } from './components/ProductBanner.js'
import { SettingsPage } from './components/SettingsPage.js'
import { StickerPicker } from './components/StickerPicker.js'
import { useProgressiveCount } from './components/useProgressiveCount.js'
import { WhatsAppConnectionPanel } from './components/WhatsAppConnectionPanel.js'
import { WorkspaceHeading } from './components/WorkspaceHeading.js'
import { WorkflowRail } from './components/WorkflowRail.js'
import { WhatsAppSendPanel } from './WhatsAppSendPanel.js'
import { createWechatImportSessionState, WechatImportPanel } from './WechatImportPanel.js'

const EMPTY_LIBRARY_WARNING = '我的表情库目前为空。请先从微信或本地导入表情。'

function draftFromTask(task: ExportTask): ExportTaskDraft {
  return {
    currentStep: task.currentStep,
    source: task.source,
    destination: task.destination,
    selectedAssetIds: task.selectedAssetIds,
    orderedAssetIds: task.orderedAssetIds,
    whatsapp: task.whatsapp,
    localFolder: task.localFolder,
  }
}

function toPreparedPacks(summary: PrepareExportSummary | null): PreparedPackView[] {
  if (!summary || summary.destination !== 'whatsapp') return []
  return summary.groups.map((group) => ({
    id: group.id,
    name: group.name,
    publisher: summary.publisher ?? '',
    mediaKind: group.mediaKind === 'animated' ? 'animated' : 'static',
    stickers: group.items.map((item) => ({
      assetId: item.assetId,
      sizeBytes: item.sizeBytes,
      durationMs: item.durationMs,
      animationTimingAdjusted: item.animationTimingAdjusted,
      droppedFrameCount: item.droppedFrameCount,
    })),
    traySizeBytes: 0,
    assetFailures: summary.assetFailures.filter((failure) =>
      group.assetIds.includes(failure.assetId),
    ),
    status: group.status,
    error: group.error,
  }))
}

export function App() {
  const [page, setPage] = useState<AppPage>('export')
  const [collection, setCollection] = useState<CollectionView | null>(null)
  const [task, setTask] = useState<ExportTask | null>(null)
  const [taskDirectory, setTaskDirectory] = useState<ExportDirectoryView | null>(null)
  const [defaultDirectory, setDefaultDirectory] = useState<DefaultExportDirectoryView | null>(null)
  const taskRef = useRef<ExportTask | null>(null)
  const saveQueue = useRef(Promise.resolve())
  const [snapshots, setSnapshots] = useState<PreparedSnapshotSummary[]>([])
  const [snapshotPreview, setSnapshotPreview] = useState<PreparedSnapshotView | null>(null)
  const [prepared, setPrepared] = useState<PrepareExportSummary | null>(null)
  const [whatsApp, setWhatsApp] = useState<WhatsAppConnectionView>(INITIAL_WHATSAPP_CONNECTION)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [prepareProgress, setPrepareProgress] = useState<PrepareProgress | null>(null)
  const [failures, setFailures] = useState<ImportFailure[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wechatOpen, setWechatOpen] = useState(false)
  const [wechatSession, setWechatSession] = useState(createWechatImportSessionState)
  const [wechatImportReady, setWechatImportReady] = useState(false)
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null)
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false)

  useEffect(() => {
    const api = window.stickerApp
    if (!api) {
      setError('桌面桥接未能启动，请重新打开应用。')
      setLoading(false)
      return
    }
    const unsubscribeImport = api.onImportProgress(setProgress)
    const unsubscribePrepare = api.onPrepareProgress(setPrepareProgress)
    const unsubscribeStatus = api.onWhatsAppStatus(setWhatsApp)
    const unsubscribeAppUpdate = api.onAppUpdateAvailable((update: AppUpdateInfo) => {
      setAppUpdateState({ currentVersion: update.currentVersion, availableUpdate: update })
      setUpdateBannerDismissed(false)
    })
    Promise.all([
      api.getCollection(),
      api.getExportTask().then(async (nextTask) => ({
        task: nextTask,
        directory:
          nextTask.destination?.kind === 'local-folder' && nextTask.destination.directoryId
            ? await api.getExportDirectory(nextTask.destination.directoryId)
            : undefined,
      })),
      api.listPreparedSnapshots(),
      api.getWhatsAppStatus(),
      api.getDefaultExportDirectory(),
      api.getAppUpdateState(),
    ])
      .then(
        ([
          nextCollection,
          taskResult,
          nextSnapshots,
          status,
          nextDefaultDirectory,
          nextAppUpdateState,
        ]) => {
          const { task: nextTask, directory: nextTaskDirectory } = taskResult
          setCollection(nextCollection)
          taskRef.current = nextTask
          setTask(nextTask)
          setTaskDirectory(nextTaskDirectory ?? null)
          setDefaultDirectory(nextDefaultDirectory ?? null)
          setSnapshots(nextSnapshots)
          setWhatsApp(status)
          setAppUpdateState(nextAppUpdateState)
        },
      )
      .catch(showError)
      .finally(() => setLoading(false))
    return () => {
      unsubscribeImport()
      unsubscribePrepare()
      unsubscribeStatus()
      unsubscribeAppUpdate()
    }
  }, [])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    document.querySelector<HTMLElement>('.product-main')?.scrollTo({ top: 0, left: 0 })
    document.querySelector<HTMLElement>('.workflow-scroll-region')?.scrollTo({ top: 0, left: 0 })
  }, [page, task?.currentStep])

  function showError(reason: unknown) {
    setError(toErrorMessage(reason))
  }

  function updateTask(patch: Partial<ExportTaskDraft>) {
    const current = taskRef.current
    const api = window.stickerApp
    if (!current || !api) return
    if (patch.currentStep !== undefined && patch.currentStep !== 1) {
      setWechatOpen(false)
    }
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    taskRef.current = next
    setTask(next)
    // 切换步骤不会使准备结果失效；其它修改（选择、配置、来源、目的地）才需要重新准备。
    if (Object.keys(patch).some((field) => field !== 'currentStep')) setPrepared(null)
    saveQueue.current = saveQueue.current
      .then(async () => {
        const latest = taskRef.current
        if (!latest) return
        const saved = await api.saveExportTask(draftFromTask(latest))
        if (taskRef.current === latest) {
          taskRef.current = saved
          setTask(saved)
        }
      })
      .catch(showError)
  }

  function moveToStep(step: ExportTask['currentStep']) {
    if (step > 1 && taskRef.current?.source?.kind === 'library' && !collection?.assets.length) {
      window.alert(EMPTY_LIBRARY_WARNING)
      return
    }
    updateTask({ currentStep: step })
  }

  function navigate(nextPage: AppPage) {
    setWechatOpen(false)
    setPage(nextPage)
  }

  function dismissWechatPanels() {
    setWechatOpen(false)
  }

  async function importAssets(mode: ImportMode) {
    const api = window.stickerApp
    if (!api) return
    dismissWechatPanels()
    setBusy(true)
    setError(null)
    setFailures([])
    try {
      applyImportSummary(await api.importAssets(mode), 'local')
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  function applyImportSummary(result: ImportSummary, sourceKind?: 'local' | 'wechat') {
    setCollection(result.collection)
    setFailures(result.failures)
    if (result.canceled) return
    const previousIds = new Set(collection?.assets.map((asset) => asset.id) ?? [])
    const importedIds =
      result.focusedAssetIds ??
      result.collection.assets
        .filter((asset) => !previousIds.has(asset.id))
        .map((asset) => asset.id)
    const latestSource = result.collection.assets
      .flatMap((asset) => asset.sources)
      .filter((source) =>
        sourceKind === 'local' ? source.kind === 'local' : source.kind.startsWith('wechat'),
      )
      .sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0]
    const source =
      sourceKind === 'local'
        ? {
            kind: 'local' as const,
            label: latestSource?.label ?? '本机导入',
            importBatchId: latestSource?.importBatchId,
          }
        : latestSource?.accountId
          ? {
              kind:
                latestSource.kind === 'wechat4' ? ('wechat4' as const) : ('wechat-legacy' as const),
              label: latestSource.label,
              sourceAccountId: latestSource.accountId,
            }
          : { kind: 'library' as const, label: '我的表情库' }
    updateTask({
      source,
      selectedAssetIds: importedIds,
      orderedAssetIds: importedIds,
      ...(sourceKind === 'wechat' ? {} : { currentStep: 2 as const }),
    })
    if (sourceKind === 'wechat') setWechatImportReady(true)
    setNotice(
      `已导入 ${result.imported} 张，跳过 ${result.duplicates} 张重复素材${
        result.failures.length > 0 ? `，${result.failures.length} 张失败` : ''
      }。新内容已保存到我的表情库。`,
    )
  }

  async function chooseLocalDestination() {
    const currentDirectoryId =
      taskRef.current?.destination?.kind === 'local-folder'
        ? taskRef.current.destination.directoryId
        : undefined
    const directory = await window.stickerApp?.chooseExportDirectory(currentDirectoryId)
    if (!directory) return
    setTaskDirectory(directory)
    updateTask({ destination: directory.choice })
  }

  async function chooseDefaultDirectory() {
    const directory = await window.stickerApp?.chooseDefaultExportDirectory()
    if (!directory) return
    setDefaultDirectory(directory)
  }

  async function checkForAppUpdate(): Promise<AppUpdateCheckResult> {
    const result = await window.stickerApp!.checkForAppUpdate()
    if (result.status === 'available') {
      setAppUpdateState({
        currentVersion: result.update.currentVersion,
        availableUpdate: result.update,
      })
      setUpdateBannerDismissed(false)
    } else if (result.status === 'up-to-date') {
      setAppUpdateState({ currentVersion: result.currentVersion })
    }
    return result
  }

  function openAppUpdateReleasePage() {
    void window.stickerApp?.openAppUpdateReleasePage().catch(showError)
  }

  async function prepareTask() {
    const api = window.stickerApp
    if (!api) return
    setBusy(true)
    setPrepareProgress({
      completed: 0,
      total: taskRef.current?.selectedAssetIds.length ?? 0,
      currentName: '',
      packIndex: 0,
      packCount: 0,
    })
    setError(null)
    try {
      await saveQueue.current
      const result = await api.prepareExportTask()
      setPrepared(result)
      const refreshed = await api.getExportTask()
      taskRef.current = refreshed
      setTask(refreshed)
      if (result.animationRepairs.length) {
        setNotice(`已自动规范化 ${result.animationRepairs.length} 张动图的短帧，其余素材不受影响。`)
      }
    } catch (reason) {
      const message = toErrorMessage(reason)
      if (!message.includes('已停止') && !message.includes('已修改')) showError(reason)
    } finally {
      setBusy(false)
      setPrepareProgress(null)
    }
  }

  async function cancelPreparation() {
    setBusy(false)
    setPrepareProgress(null)
    setNotice('已请求停止准备；当前素材结束清理后不会继续处理。')
    await window.stickerApp?.cancelExportPreparation()
  }

  async function saveSnapshot(forceDuplicate = false) {
    const api = window.stickerApp
    if (!api) return
    setBusy(true)
    try {
      const result = await api.savePreparedSnapshot(forceDuplicate)
      if (result.kind === 'duplicate' && !forceDuplicate) {
        const saveCopy = window.confirm(
          '已有内容、顺序和配置完全相同的已保存版本。是否仍另存为副本？',
        )
        if (saveCopy) return void saveSnapshot(true)
        setNotice('已打开相同的已保存版本。')
      } else {
        setNotice('已保留本次准备结果，可在「表情分组存档」查看并再次传输')
      }
      setSnapshots(await api.listPreparedSnapshots())
      const refreshed = await api.getExportTask()
      taskRef.current = refreshed
      setTask(refreshed)
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function deleteSnapshot(id: string) {
    if (!window.confirm('删除这个表情分组存档？我的表情库素材不会删除。')) return
    try {
      await window.stickerApp?.deletePreparedSnapshot(id)
      setSnapshots((current) => current.filter((snapshot) => snapshot.id !== id))
    } catch (reason) {
      showError(reason)
    }
  }

  async function openSnapshot(id: string) {
    try {
      const snapshot = await window.stickerApp?.getPreparedSnapshot(id)
      if (snapshot) setSnapshotPreview(snapshot)
    } catch (reason) {
      showError(reason)
    }
  }

  async function useSnapshot(id: string) {
    try {
      const result = await window.stickerApp?.usePreparedSnapshot(id)
      if (!result) return
      taskRef.current = result.task
      setTask(result.task)
      setPrepared(result.summary)
      setSnapshotPreview(null)
      setPage('export')
      const whatsAppDestination = result.task.destination?.kind === 'whatsapp'
      if (whatsAppDestination && whatsApp && whatsApp.phase !== 'connected') {
        setNotice(
          `已载入「${result.summary.name}」，其目的地是 WhatsApp。当前未连接，请在确认发送前先连接。`,
        )
      } else if (
        result.task.destination?.kind === 'local-folder' &&
        !result.task.destination.directoryId
      ) {
        setNotice(`已载入「${result.summary.name}」，请选择本地导出位置后确认导出。`)
      } else {
        setNotice(`已载入「${result.summary.name}」，可直接在第 4 步确认传输。`)
      }
    } catch (reason) {
      showError(reason)
    }
  }

  async function transferLocal() {
    const api = window.stickerApp
    if (!api) return
    if (!window.confirm('确认开始导出到所选本地文件夹？应用会创建新的导出批次，不会覆盖原素材。'))
      return
    setBusy(true)
    try {
      const result = await api.transferLocalExport()
      setNotice(
        `已导出 ${result.assetCount} 张素材到“${result.directoryLabel}”，共 ${result.groupCount} 个文件夹分组。`,
      )
      const refreshed = await api.getExportTask()
      taskRef.current = refreshed
      setTask(refreshed)
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function removeAssets(ids: string[]) {
    const api = window.stickerApp
    if (!api || !ids.length) return
    if (!window.confirm(`从我的表情库删除所选 ${ids.length} 张素材？表情分组存档仍保留独立副本。`))
      return
    try {
      const next = await api.removeAssets(ids)
      setCollection(next)
      const refreshed = await api.getExportTask()
      taskRef.current = refreshed
      setTask(refreshed)
    } catch (reason) {
      showError(reason)
    }
  }

  function continueAfterWechatImport() {
    setPage('export')
    updateTask({ currentStep: 2 })
  }

  const wechatPanel = wechatOpen ? (
    <WechatImportPanel
      session={wechatSession}
      onSessionChange={setWechatSession}
      canContinue={wechatImportReady}
      onContinue={continueAfterWechatImport}
      onLoadStarted={() => setWechatImportReady(false)}
      onClose={() => setWechatOpen(false)}
      onImported={(result) => applyImportSummary(result, 'wechat')}
      onStopped={() => setNotice('已停止当前微信任务。')}
    />
  ) : null

  const content =
    loading || !collection || !task ? (
      <div className="product-loading">正在恢复我的表情库与导出任务…</div>
    ) : page === 'export' ? (
      <ExportPage
        collection={collection}
        task={task}
        prepared={prepared}
        whatsApp={whatsApp}
        busy={busy}
        progress={progress}
        failures={failures}
        taskDirectory={taskDirectory}
        defaultDirectory={defaultDirectory}
        onTask={updateTask}
        onStep={moveToStep}
        onLocalImport={importAssets}
        onWechat={() => setWechatOpen(true)}
        onDismissWechat={dismissWechatPanels}
        wechatPanel={wechatPanel}
        onChooseLocalDestination={chooseLocalDestination}
        onPrepare={prepareTask}
        prepareProgress={prepareProgress}
        onCancelPrepare={cancelPreparation}
        onSaveSnapshot={saveSnapshot}
        onTransferLocal={transferLocal}
        onDeleteAssets={removeAssets}
        onError={setError}
        onWhatsAppStatus={setWhatsApp}
        onRefreshTask={() => {
          void window.stickerApp?.getExportTask().then((refreshed) => {
            taskRef.current = refreshed
            setTask(refreshed)
          })
        }}
      />
    ) : page === 'library' ? (
      <LibraryPage
        collection={collection}
        onSelection={async (ids) => setCollection(await window.stickerApp!.setSelection(ids))}
        onOrder={async (ids) => setCollection(await window.stickerApp!.reorderAssets(ids))}
        onDelete={removeAssets}
        onLocalImport={importAssets}
        onWechat={() => setWechatOpen(true)}
        wechatPanel={wechatPanel}
      />
    ) : page === 'archives' ? (
      <ArchivesPage
        snapshots={snapshots}
        onOpen={openSnapshot}
        onUse={useSnapshot}
        onDelete={deleteSnapshot}
      />
    ) : page === 'connections' ? (
      <ConnectionsPage
        connection={whatsApp}
        onError={setError}
        onStatus={setWhatsApp}
        onWechat={() => setWechatOpen(true)}
        wechatPanel={wechatPanel}
      />
    ) : page === 'settings' ? (
      <SettingsPage
        task={task}
        defaultDirectory={defaultDirectory}
        updateState={appUpdateState}
        onChooseDirectory={chooseDefaultDirectory}
        onCheckUpdate={checkForAppUpdate}
        onOpenUpdatePage={openAppUpdateReleasePage}
      />
    ) : (
      <AboutPage />
    )

  return (
    <AppShell
      page={page}
      onNavigate={navigate}
      rail={
        page === 'export' && task ? (
          <WorkflowRail
            task={task}
            directoryPath={
              task.destination?.kind === 'local-folder' &&
              taskDirectory &&
              task.destination.directoryId === taskDirectory?.choice.directoryId
                ? taskDirectory.path
                : undefined
            }
            onStep={moveToStep}
          />
        ) : undefined
      }
    >
      {error && <ProductBanner tone="error" message={error} onDismiss={() => setError(null)} />}
      {notice && <ProductBanner tone="notice" message={notice} onDismiss={() => setNotice(null)} />}
      {!error && !notice && !updateBannerDismissed && appUpdateState?.availableUpdate && (
        <ProductBanner
          tone="notice"
          message={`发现新版本 ${appUpdateState.availableUpdate.latestVersion}`}
          actionLabel="查看版本"
          onAction={openAppUpdateReleasePage}
          onDismiss={() => setUpdateBannerDismissed(true)}
        />
      )}
      {snapshotPreview && (
        <SnapshotPreviewDialog
          snapshot={snapshotPreview}
          onClose={() => setSnapshotPreview(null)}
        />
      )}
      {content}
    </AppShell>
  )
}

interface ExportPageProps {
  collection: CollectionView
  task: ExportTask
  prepared: PrepareExportSummary | null
  whatsApp: WhatsAppConnectionView
  busy: boolean
  progress: ImportProgress | null
  failures: ImportFailure[]
  taskDirectory: ExportDirectoryView | null
  defaultDirectory: DefaultExportDirectoryView | null
  onTask(patch: Partial<ExportTaskDraft>): void
  onStep(step: ExportTask['currentStep']): void
  onLocalImport(mode: ImportMode): void
  onWechat(): void
  onDismissWechat(): void
  wechatPanel: React.ReactNode
  onChooseLocalDestination(): void
  onPrepare(): void
  prepareProgress: PrepareProgress | null
  onCancelPrepare(): void
  onSaveSnapshot(forceDuplicate?: boolean): void
  onTransferLocal(): void
  onDeleteAssets(ids: string[]): void | Promise<void>
  onError(message: string): void
  onWhatsAppStatus(status: WhatsAppConnectionView): void
  onRefreshTask(): void
}

function ExportPage(props: ExportPageProps) {
  const { task } = props
  if (task.currentStep === 1) return <SourceStep {...props} />
  if (task.currentStep === 2) return <DestinationStep {...props} />
  if (task.currentStep === 3) return <PickerStep {...props} />
  return <TransferStep {...props} />
}

function WorkflowFooter({
  title,
  detail,
  actionLabel,
  disabled,
  onAction,
}: {
  title: React.ReactNode
  detail?: React.ReactNode
  actionLabel: string
  disabled?: boolean
  onAction(): void
}) {
  return (
    <footer className="workspace-footer">
      <span>
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      <button className="primary-button" type="button" disabled={disabled} onClick={onAction}>
        {actionLabel}
      </button>
    </footer>
  )
}

function WorkflowStepWithFooter({
  children,
  ...footerProps
}: React.PropsWithChildren<React.ComponentProps<typeof WorkflowFooter>>) {
  return (
    <div className="workflow-workspace has-workspace-footer">
      <div className="workflow-scroll-region">{children}</div>
      <WorkflowFooter {...footerProps} />
    </div>
  )
}

function SourceStep(props: ExportPageProps) {
  const initialFocus = props.task.source?.kind.startsWith('wechat')
    ? 'wechat'
    : props.task.source?.kind === 'local'
      ? 'local'
      : props.task.source?.kind === 'library'
        ? 'library'
        : 'wechat'
  const [focusedSource, setFocusedSource] = useState<'wechat' | 'local' | 'library'>(initialFocus)

  useEffect(() => {
    if (props.wechatPanel) setFocusedSource('wechat')
  }, [props.wechatPanel])

  function focusCard(event: React.MouseEvent<HTMLElement>) {
    if (!(event.target as HTMLElement).closest('button')) event.currentTarget.focus()
  }

  return (
    <div className="workflow-workspace">
      <WorkspaceHeading
        title="选择素材来源"
        description="选择这次传输的素材来源。新导入的内容会被安全保存到「我的表情库」"
      />
      <div className="choice-list">
        <section
          className={`choice-row${focusedSource === 'wechat' ? ' is-selected' : ''}`}
          tabIndex={0}
          aria-label="从微信导入"
          onFocus={() => setFocusedSource('wechat')}
          onClick={focusCard}
        >
          <span className="destination-icon wechat">
            <WechatLogo size={34} weight="fill" />
          </span>
          <div>
            <h3>从微信导入</h3>
            <p>选择一个微信账号，导入收藏的表情</p>
            <small>微信账号已加密，任何微信数据都不会被修改或上传</small>
          </div>
          <div className="choice-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setFocusedSource('wechat')
                props.onWechat()
              }}
            >
              选择账号
            </button>
          </div>
        </section>
        {props.wechatPanel && <div className="source-inline-panel">{props.wechatPanel}</div>}
        <section
          className={`choice-row${focusedSource === 'local' ? ' is-selected' : ''}`}
          tabIndex={0}
          aria-label="从本机导入"
          onFocus={() => {
            setFocusedSource('local')
          }}
          onClick={(event) => {
            setFocusedSource('local')
            props.onDismissWechat()
            focusCard(event)
          }}
        >
          <span className="destination-icon">
            <FolderOpen size={32} />
          </span>
          <div>
            <h3>从本机导入</h3>
            <p>支持选择单张、多张图片或整个文件夹</p>
            <small>支持的格式: PNG, JPG, JPEG, WebP, GIF</small>
          </div>
          <div className="choice-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={props.busy}
              onClick={() => props.onLocalImport('files-or-directory')}
            >
              选择文件
            </button>
          </div>
        </section>
        <button
          className={`choice-row choice-button${focusedSource === 'library' ? ' is-selected' : ''}`}
          type="button"
          onFocus={() => setFocusedSource('library')}
          onClick={() => {
            props.onDismissWechat()
            if (!props.collection.assets.length) {
              window.alert(EMPTY_LIBRARY_WARNING)
              return
            }
            props.onTask({ source: { kind: 'library', label: '我的表情库' }, currentStep: 2 })
          }}
        >
          <span className="destination-icon">
            <Images size={32} />
          </span>
          <span>
            <strong>使用我的表情库</strong>
            <small>不重新导入，直接挑选已有素材</small>
          </span>
          <ArrowRight size={20} />
        </button>
      </div>
      {props.progress && (
        <div className="compact-progress">
          正在导入 {props.progress.completed} / {props.progress.total}
        </div>
      )}
      {props.failures.length > 0 && (
        <p className="inline-note warning">
          有 {props.failures.length} 个文件未导入，成功素材已保留。
        </p>
      )}
      <p className="privacy-line">
        <ShieldCheck size={17} />
        安全承诺 - 所有图片与数据均在本地处理、不会被上传到网络
      </p>
    </div>
  )
}

function DestinationStep(props: ExportPageProps) {
  const connected = props.whatsApp.phase === 'connected'
  const [focusedDestination, setFocusedDestination] = useState<'whatsapp' | 'local'>(
    props.task.destination?.kind === 'local-folder' ? 'local' : 'whatsapp',
  )
  const [whatsAppPanelOpen, setWhatsAppPanelOpen] = useState(
    props.task.destination?.kind === 'whatsapp' && !connected,
  )

  useEffect(() => {
    if (props.task.destination?.kind === 'local-folder') setFocusedDestination('local')
    if (props.task.destination?.kind === 'whatsapp') setFocusedDestination('whatsapp')
  }, [props.task.destination?.kind])

  const selectedLocalPath =
    props.task.destination?.kind === 'local-folder' &&
    props.taskDirectory &&
    props.task.destination.directoryId === props.taskDirectory?.choice.directoryId
      ? props.taskDirectory.path
      : undefined
  const destinationReady =
    (props.task.destination?.kind === 'whatsapp' && connected) ||
    (props.task.destination?.kind === 'local-folder' && Boolean(props.task.destination.directoryId))
  const destinationTitle = !destinationReady
    ? '尚未选择目的地'
    : props.task.destination?.kind === 'whatsapp'
      ? '已选择 WhatsApp'
      : '已选择本地文件夹'
  const destinationDetail = !destinationReady ? (
    '选择一个目的地后即可继续。'
  ) : props.task.destination?.kind === 'whatsapp' ? (
    'WhatsApp 已连接，可以继续挑选传输表情。'
  ) : selectedLocalPath ? (
    <PathDisplay path={selectedLocalPath} prefix="将导出到 " />
  ) : (
    `将导出到 ${props.task.destination?.directoryLabel ?? '所选文件夹'}。`
  )
  return (
    <WorkflowStepWithFooter
      title={destinationTitle}
      detail={destinationDetail}
      actionLabel="下一步"
      disabled={!destinationReady}
      onAction={() => props.onStep(3)}
    >
      <WorkspaceHeading
        title="选择目的地"
        description="目的地是必选项。只有 WhatsApp 需要先建立连接。"
      />
      <div className="choice-list">
        <section
          className={`choice-row${focusedDestination === 'whatsapp' ? ' is-selected' : ''}`}
          tabIndex={0}
          aria-label="选择 WhatsApp"
          onFocus={() => setFocusedDestination('whatsapp')}
          onClick={(event) => {
            if (!(event.target as HTMLElement).closest('button')) event.currentTarget.focus()
          }}
        >
          <span className="destination-icon whatsapp">
            <WhatsappLogo size={34} />
          </span>
          <div>
            <h3>WhatsApp</h3>
            <p>
              {connected
                ? '已连接，可以准备并发送原生贴纸包'
                : `${whatsAppConnectionLabel(props.whatsApp.phase)}，可在这里完成关联`}
            </p>
          </div>
          <button
            className={connected ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() => {
              setFocusedDestination('whatsapp')
              if (connected) {
                props.onTask({ destination: { kind: 'whatsapp' }, currentStep: 3 })
                return
              }
              setWhatsAppPanelOpen(true)
              props.onTask({ destination: { kind: 'whatsapp' } })
            }}
          >
            {connected ? '下一步' : '连接并选择'}
          </button>
        </section>
        {!connected && whatsAppPanelOpen && (
          <WhatsAppConnectionPanel
            connection={props.whatsApp}
            compact
            onStatus={props.onWhatsAppStatus}
            onError={props.onError}
            onClose={() => setWhatsAppPanelOpen(false)}
          />
        )}
        <section
          className={`choice-row destination-choice-row${focusedDestination === 'local' ? ' is-selected' : ''}`}
          tabIndex={0}
          aria-label="导出到本地文件夹"
          onFocus={() => {
            setFocusedDestination('local')
            setWhatsAppPanelOpen(false)
          }}
          onClick={(event) => {
            setFocusedDestination('local')
            setWhatsAppPanelOpen(false)
            if (!(event.target as HTMLElement).closest('button')) event.currentTarget.focus()
          }}
        >
          <span className="destination-icon">
            <FolderOpen size={32} />
          </span>
          <div>
            <h3>导出到本地文件夹</h3>
            <small>
              {props.task.destination?.kind === 'local-folder' ? (
                selectedLocalPath ? (
                  <PathDisplay path={selectedLocalPath} />
                ) : (
                  (props.task.destination.directoryLabel ?? '本次导出位置')
                )
              ) : props.defaultDirectory?.path ? (
                <PathDisplay path={props.defaultDirectory.path} prefix="默认位置：" />
              ) : (
                '尚未设置默认位置，点击选择本次导出位置'
              )}
            </small>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setFocusedDestination('local')
              setWhatsAppPanelOpen(false)
              props.onChooseLocalDestination()
            }}
          >
            选择文件夹
          </button>
        </section>
        <section className="choice-row is-disabled">
          <span className="destination-icon">
            <Link size={30} />
          </span>
          <div>
            <h3>更多 App 即将支持</h3>
            <small>目前可先导出到本地文件夹，由您手动添加。</small>
          </div>
        </section>
      </div>
    </WorkflowStepWithFooter>
  )
}

function PickerStep(props: ExportPageProps) {
  const animated = props.collection.assets.filter(
    (asset) => props.task.selectedAssetIds.includes(asset.id) && asset.animated,
  ).length
  const hasSelection = props.task.selectedAssetIds.length > 0
  return (
    <WorkflowStepWithFooter
      title={hasSelection ? `${props.task.selectedAssetIds.length} 张已选择` : '尚未选择表情'}
      detail={
        hasSelection ? (
          <>
            包含 {animated} 张动图。
            {props.task.destination?.kind === 'whatsapp'
              ? '静态和动图会自动分开传输。'
              : '将按本地文件夹规则分组。'}
          </>
        ) : (
          '至少选择一张表情后即可继续。'
        )
      }
      actionLabel="下一步"
      disabled={!hasSelection}
      onAction={() => props.onStep(4)}
    >
      <WorkspaceHeading
        title="挑选传输表情"
        description={`我的表情库共有 ${props.collection.assets.length} 张素材。此处选择的表情会在下一步被传输，选择的序号将影响传输时的先后顺序。`}
        aside={
          <strong className="heading-count">已选择 {props.task.selectedAssetIds.length} 张</strong>
        }
      />
      <StickerPicker
        assets={props.collection.assets}
        selectedIds={props.task.selectedAssetIds}
        orderedIds={props.task.orderedAssetIds}
        mode="export"
        onSelection={(ids) => props.onTask({ selectedAssetIds: ids })}
        onOrder={(ids) => props.onTask({ orderedAssetIds: ids })}
        onDelete={props.onDeleteAssets}
      />
    </WorkflowStepWithFooter>
  )
}

function TransferStep(props: ExportPageProps) {
  const { task, prepared } = props
  const whatsAppDestination = task.destination?.kind === 'whatsapp'
  const preparedPacks = useMemo(() => toPreparedPacks(prepared), [prepared])
  const sendablePackIds = useMemo(
    () =>
      prepared?.groups.filter((group) => group.status === 'prepared').map((group) => group.id) ??
      [],
    [prepared],
  )
  const [selectedPackIds, setSelectedPackIds] = useState<string[]>([])
  const [previewGroupId, setPreviewGroupId] = useState<string | null>(null)
  const progressiveGroups = useProgressiveCount({
    total: prepared?.groups.length ?? 0,
    initialCount: 10,
    batchSize: 10,
    resetKey: prepared?.fingerprint ?? 'no-prepared-result',
  })
  const renderedGroups = prepared?.groups.slice(0, progressiveGroups.visibleCount) ?? []
  const previewGroup = prepared?.groups.find((group) => group.id === previewGroupId)

  useEffect(() => {
    setSelectedPackIds(sendablePackIds)
    setPreviewGroupId(null)
  }, [prepared?.fingerprint, sendablePackIds])

  function togglePack(packId: string) {
    setSelectedPackIds((current) =>
      current.includes(packId) ? current.filter((id) => id !== packId) : [...current, packId],
    )
  }

  return (
    <div className="workflow-workspace transfer-workspace">
      <WorkspaceHeading
        title="检查并传输"
        description={
          whatsAppDestination
            ? 'WhatsApp 要求静态与动图分开传输。检查配置与分包后再确认发送。'
            : '确认输出格式、命名规则和文件夹分组，再开始本地导出。'
        }
      />
      {whatsAppDestination && <PackRulesNotice />}
      {whatsAppDestination ? (
        <div className="transfer-fields">
          <label>
            <span>表情包名称</span>
            <input
              value={task.whatsapp.title}
              maxLength={128}
              onChange={(event) =>
                props.onTask({ whatsapp: { ...task.whatsapp, title: event.target.value } })
              }
            />
          </label>
          <label>
            <span>发布者</span>
            <input
              value={task.whatsapp.publisher}
              maxLength={128}
              onChange={(event) =>
                props.onTask({ whatsapp: { ...task.whatsapp, publisher: event.target.value } })
              }
            />
          </label>
          <label>
            <span>每包数量</span>
            <input
              type="number"
              min={3}
              max={30}
              value={task.whatsapp.packSize}
              onChange={(event) =>
                props.onTask({
                  whatsapp: { ...task.whatsapp, packSize: Number(event.target.value) },
                })
              }
            />
          </label>
        </div>
      ) : (
        <LocalTransferFields
          task={task}
          directoryPath={
            task.destination?.kind === 'local-folder' &&
            props.taskDirectory &&
            task.destination.directoryId === props.taskDirectory?.choice.directoryId
              ? props.taskDirectory.path
              : undefined
          }
          onTask={props.onTask}
          onChooseDestination={props.onChooseLocalDestination}
        />
      )}
      <section className="prepared-preview">
        <div className="section-heading-row">
          <div>
            <h3>{whatsAppDestination ? '传输预览' : '文件夹分组预览'}</h3>
            <p>
              {prepared
                ? `${prepared.groups.length} 个${whatsAppDestination ? '表情包' : '文件夹分组'}，${prepared.groups.reduce((count, group) => count + group.items.length, 0)} 张素材`
                : '准备后会显示每组素材与转换状态。'}
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={props.busy || !task.selectedAssetIds.length}
            onClick={props.onPrepare}
          >
            {props.busy ? '正在准备' : task.prepared ? '重新准备' : '准备传输'}
          </button>
        </div>
        {props.busy && props.prepareProgress && (
          <div className="prepare-progress transfer-prepare-progress" aria-live="polite">
            <div>
              <span>
                正在准备 {props.prepareProgress.completed} / {props.prepareProgress.total}
              </span>
              <span>{props.prepareProgress.currentName || '正在检查准备缓存…'}</span>
            </div>
            <div className="progress-line">
              <span
                style={{
                  width: `${props.prepareProgress.total ? Math.max(2, (props.prepareProgress.completed / props.prepareProgress.total) * 100) : 2}%`,
                }}
              />
            </div>
            <button className="text-button" type="button" onClick={props.onCancelPrepare}>
              停止准备
            </button>
          </div>
        )}
        {prepared?.warnings.map((warning) => (
          <p className="inline-note warning" key={warning}>
            {warning}
          </p>
        ))}
        {prepared && prepared.assetFailures.length > 0 && (
          <PreparationFailurePanel
            key={`failures-${prepared.fingerprint}`}
            failures={prepared.assetFailures}
          />
        )}
        {prepared && whatsAppDestination && (
          <div className="prepared-selection-bar">
            <span>
              已选择 {selectedPackIds.length} / {sendablePackIds.length} 个可发送表情包
            </span>
            <div>
              <button
                type="button"
                disabled={selectedPackIds.length === sendablePackIds.length}
                onClick={() => setSelectedPackIds(sendablePackIds)}
              >
                全选
              </button>
              <span aria-hidden="true" />
              <button
                type="button"
                disabled={selectedPackIds.length === 0}
                onClick={() => setSelectedPackIds([])}
              >
                取消选择
              </button>
            </div>
          </div>
        )}
        {prepared && (
          <div className="prepared-groups">
            {renderedGroups.map((group) => {
              const selected = selectedPackIds.includes(group.id)
              return (
                <article
                  key={group.id}
                  className={`${whatsAppDestination ? 'is-selectable ' : ''}${
                    group.status === 'failed' ? 'is-failed' : ''
                  }${whatsAppDestination && !selected ? ' is-excluded' : ''}`}
                >
                  {whatsAppDestination && (
                    <label className="prepared-pack-choice">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={group.status === 'failed'}
                        onChange={() => togglePack(group.id)}
                      />
                      <span className="visually-hidden">
                        {selected ? `取消发送 ${group.name}` : `发送 ${group.name}`}
                      </span>
                    </label>
                  )}
                  <button
                    className="prepared-group-open"
                    type="button"
                    onClick={() => setPreviewGroupId(group.id)}
                  >
                    <span className="prepared-group-copy">
                      <strong>{group.name}</strong>
                      <span>
                        {group.items.length} 张 ·{' '}
                        {group.mediaKind === 'animated'
                          ? '动图'
                          : group.mediaKind === 'static'
                            ? '静态表情'
                            : '混合素材'}
                      </span>
                    </span>
                    <span className="prepared-thumbs">
                      {group.items.slice(0, 12).map((item) => (
                        <ProgressiveImage src={item.previewUrl} alt="" key={item.id} />
                      ))}
                    </span>
                  </button>
                  <span className="prepared-group-side">
                    <button
                      className="prepared-group-preview"
                      type="button"
                      aria-label={`预览 ${group.name}`}
                      onClick={() => setPreviewGroupId(group.id)}
                    >
                      <Eye size={15} />
                    </button>
                    <small
                      className={`prepared-group-status ${
                        group.status === 'failed'
                          ? 'is-failed'
                          : whatsAppDestination && !selected
                            ? 'is-excluded'
                            : 'is-ready'
                      }`}
                    >
                      {group.status === 'failed'
                        ? '准备失败'
                        : whatsAppDestination
                          ? selected
                            ? '未传输'
                            : '不传输'
                          : '未导出'}
                    </small>
                  </span>
                </article>
              )
            })}
          </div>
        )}
        {prepared && progressiveGroups.hasMore && (
          <button
            className="progressive-load-more"
            type="button"
            ref={progressiveGroups.sentinelRef}
            onClick={progressiveGroups.showMore}
          >
            已显示 {progressiveGroups.visibleCount} / {prepared.groups.length} 个分组，继续加载
          </button>
        )}
      </section>
      {prepared && (
        <div className="snapshot-save-card">
          <div className="snapshot-save-copy">
            <strong>保留本次准备结果</strong>
            <small>保存不可变副本，以后可预览或再次传输。</small>
          </div>
          {task.prepared?.snapshotId ? (
            <span className="snapshot-save-status">
              <CheckCircle size={15} weight="bold" /> 已保存
            </span>
          ) : (
            <button
              className="snapshot-save-button"
              type="button"
              disabled={props.busy}
              onClick={() => props.onSaveSnapshot()}
            >
              保存分组存档
            </button>
          )}
        </div>
      )}
      {prepared && whatsAppDestination && (
        <WhatsAppSendPanel
          connection={props.whatsApp}
          expectedPackCount={prepared.groups.length}
          preparedPacks={preparedPacks}
          selectedPackIds={selectedPackIds}
          onConnectionChange={props.onWhatsAppStatus}
          onError={props.onError}
          onSent={props.onRefreshTask}
        />
      )}
      {prepared && !whatsAppDestination && (
        <div className="workspace-footer">
          <span>将创建新的本地导出批次，不覆盖原文件。</span>
          <button
            className="primary-button"
            type="button"
            disabled={props.busy || prepared.groups.some((group) => group.status === 'failed')}
            onClick={props.onTransferLocal}
          >
            导出到本地文件夹
          </button>
        </div>
      )}
      {previewGroup && (
        <PreparedPackPreviewDialog group={previewGroup} onClose={() => setPreviewGroupId(null)} />
      )}
    </div>
  )
}

function PackRulesNotice() {
  return (
    <DismissibleInfoNotice
      title="WhatsApp 分包规则"
      ariaLabel="WhatsApp 分包规则"
      closeLabel="关闭分包规则提示"
      className="pack-rules-notice"
    >
      <ul>
        <li>每个包必须包含 3-30 张图片。数量或余数发生冲突时，系统会自动选择最合适的分包方式。</li>
        <li>动图和静态表情必须放在不同的包里，系统会自动分开。</li>
      </ul>
    </DismissibleInfoNotice>
  )
}

function PreparedPackPreviewDialog({
  group,
  onClose,
}: {
  group: PrepareExportSummary['groups'][number]
  onClose(): void
}) {
  const kindLabel =
    group.mediaKind === 'animated' ? '动图' : group.mediaKind === 'static' ? '静态表情' : '混合素材'

  return (
    <Dialog
      className="prepared-pack-preview-dialog"
      surfaceAs="section"
      ariaLabelledBy="prepared-pack-preview-title"
      onClose={onClose}
    >
      <header>
        <div>
          <h2 id="prepared-pack-preview-title">{group.name}</h2>
          <p>
            {group.items.length} 张 · {kindLabel}
          </p>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭预览">
          <X size={18} />
        </button>
      </header>
      <div className="prepared-pack-preview-grid">
        {group.items.map((item, index) => (
          <figure key={item.id}>
            <ProgressiveImage
              src={item.previewUrl}
              alt={`${group.name}中的第 ${index + 1} 张表情`}
            />
            <figcaption>{index + 1}</figcaption>
          </figure>
        ))}
      </div>
    </Dialog>
  )
}

function PreparationFailurePanel({
  failures,
}: {
  failures: PrepareExportSummary['assetFailures']
}) {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()

  return (
    <section className="preparation-failures" aria-live="polite">
      <button
        className="preparation-failures-trigger"
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        onClick={() => setExpanded((current) => !current)}
      >
        <WarningCircle size={17} />
        <span>
          <strong>{failures.length} 张异常素材未能准备</strong>
          {expanded && <small>收起错误详情</small>}
        </span>
        <CaretDown size={16} weight="bold" aria-hidden="true" />
      </button>
      {expanded && (
        <ul id={detailId}>
          {failures.map((failure) => (
            <li key={failure.assetId}>{failure.message}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

function LocalTransferFields({
  task,
  directoryPath,
  onTask,
  onChooseDestination,
}: {
  task: ExportTask
  directoryPath?: string
  onTask(patch: Partial<ExportTaskDraft>): void
  onChooseDestination(): void
}) {
  return (
    <div className="local-transfer-settings">
      <button className="destination-summary" type="button" onClick={onChooseDestination}>
        <FolderOpen size={20} />
        <span>
          <strong>
            {directoryPath ? (
              <PathDisplay path={directoryPath} />
            ) : task.destination?.kind === 'local-folder' ? (
              (task.destination.directoryLabel ?? '选择导出位置')
            ) : (
              '选择导出位置'
            )}
          </strong>
          <small>点击更改本地文件夹</small>
        </span>
      </button>
      <div className="transfer-fields">
        <label>
          <span>批次名称</span>
          <input
            value={task.localFolder.batchName}
            onChange={(event) =>
              onTask({ localFolder: { ...task.localFolder, batchName: event.target.value } })
            }
          />
        </label>
        <label>
          <span>输出格式</span>
          <select
            value={task.localFolder.format}
            onChange={(event) =>
              onTask({
                localFolder: {
                  ...task.localFolder,
                  format: event.target.value as 'original' | 'converted-webp',
                },
              })
            }
          >
            <option value="original">保留原格式</option>
            <option value="converted-webp">转换为 WebP</option>
          </select>
        </label>
        <label>
          <span>命名规则</span>
          <select
            value={task.localFolder.naming}
            onChange={(event) =>
              onTask({
                localFolder: {
                  ...task.localFolder,
                  naming: event.target.value as 'original' | 'sequence',
                },
              })
            }
          >
            <option value="original">保留原文件名</option>
            <option value="sequence">按顺序编号</option>
          </select>
        </label>
        <label>
          <span>每文件夹数量</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={task.localFolder.itemsPerFolder}
            onChange={(event) =>
              onTask({
                localFolder: { ...task.localFolder, itemsPerFolder: Number(event.target.value) },
              })
            }
          />
        </label>
      </div>
    </div>
  )
}
