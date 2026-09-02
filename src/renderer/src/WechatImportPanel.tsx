import { Fragment, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/ArrowRight'
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise'
import { CheckIcon as Check } from '@phosphor-icons/react/Check'
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/DownloadSimple'
import { InfoIcon as Info } from '@phosphor-icons/react/Info'
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/ShieldCheck'
import { WarningIcon as Warning } from '@phosphor-icons/react/Warning'
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/WechatLogo'
import { XIcon as X } from '@phosphor-icons/react/X'

import type {
  ImportProgress,
  ImportSummary,
  LegacyWechatAccountView,
  LegacyWechatDiscoveryView,
  Wechat4GateStatus,
  Wechat4ImportAccountView,
  Wechat4ImportDiscoveryView,
  Wechat4OfficialAlbumView,
  WechatAccountPreviewView,
  WechatStagedAssetView,
  WechatStagedImportView,
  WechatDownloadMode,
} from '../../shared/domain.js'
import { toErrorMessage } from '../../shared/errors.js'
import type {
  VxPluginCapability,
  VxPluginDistributionAvailability,
  VxPluginInstallProgress,
} from '../../shared/vx-plugin.js'
import { Dialog } from './components/Dialog.js'
import { DismissibleInfoNotice } from './components/DismissibleInfoNotice.js'
import { ProgressiveImage } from './components/ProgressiveImage.js'
import { StickerImagePreviewDialog } from './components/StickerImagePreviewDialog.js'
import { StickerPicker } from './components/StickerPicker.js'
import { useBoxSelection } from './components/useBoxSelection.js'
import { WechatDownloadSettings } from './components/WechatDownloadSettings.js'

export type WechatAccount =
  | { kind: 'current'; account: Wechat4ImportAccountView }
  | { kind: 'legacy'; account: LegacyWechatAccountView }

type WechatAccountAction = 'preview' | 'download'

interface PendingAction {
  account: Wechat4ImportAccountView
  action: WechatAccountAction
}

export interface ActiveTask {
  item: WechatAccount
  action: WechatAccountAction
}

export interface DownloadedImport {
  item: WechatAccount
  stagedImport: WechatStagedImportView
}

interface WechatDiscoveries {
  current: Wechat4ImportDiscoveryView
  legacy: LegacyWechatDiscoveryView
}

export interface WechatImportSessionState {
  activeTask: ActiveTask | null
  accountPreviews: Record<string, WechatAccountPreviewView>
  downloadedImport: DownloadedImport | null
  officialAccount: Wechat4ImportAccountView | null
  officialAlbums: Wechat4OfficialAlbumView[]
  officialAlbumsLoading: boolean
  officialAlbumsError: string | null
  officialSelectedIds: string[]
  officialImporting: boolean
  downloadMode: WechatDownloadMode
  progress: ImportProgress | null
  gateStatus: Wechat4GateStatus
}

export function createWechatImportSessionState(): WechatImportSessionState {
  return {
    activeTask: null,
    accountPreviews: {},
    downloadedImport: null,
    officialAccount: null,
    officialAlbums: [],
    officialAlbumsLoading: false,
    officialAlbumsError: null,
    officialSelectedIds: [],
    officialImporting: false,
    downloadMode: 'default',
    progress: null,
    gateStatus: { phase: 'idle', message: '等待选择账号' },
  }
}

const EMPTY_DISCOVERIES: WechatDiscoveries = {
  current: { rootFound: false, permissionDenied: false, accounts: [], failures: [] },
  legacy: { rootFound: false, permissionDenied: false, accounts: [], failures: [] },
}

function accountKey(item: WechatAccount): string {
  return `${item.kind}:${item.account.id}`
}

function importStatusLabel(status: Wechat4GateStatus): string {
  switch (status.phase) {
    case 'preparing':
      return '正在准备导入'
    case 'quitting-original':
      return '正在关闭当前微信'
    case 'copying':
    case 'signing':
      return '正在准备临时微信'
    case 'awaiting-qr':
      return '等待扫码与数据加载'
    case 'awaiting-favorites':
      return '等待打开收藏表情'
    case 'validating':
      return '正在读取个人收藏数据'
    case 'resolving':
      return '正在获取个人收藏表情'
    case 'importing':
      return '正在保存到我的表情库'
    case 'cleaning':
      return '正在关闭临时微信并恢复原微信'
    case 'complete':
      return '即将完成'
    default:
      return status.message
  }
}

function ImportProgressLine({
  completed,
  total,
  fallbackPercent = 0,
}: {
  completed: number
  total: number
  fallbackPercent?: number
}) {
  const percent = total > 0 ? Math.min(100, (completed / total) * 100) : fallbackPercent
  return (
    <div
      className="progress-line"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={Math.max(total, 1)}
      aria-valuenow={Math.min(completed, Math.max(total, 1))}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  )
}

export function WechatImportPanel({
  onClose,
  onImported,
  onStopped,
  onLoadStarted,
  onContinue,
  canContinue,
  session,
  onSessionChange,
}: {
  onClose: () => void
  onImported: (summary: ImportSummary) => void
  onStopped: () => void
  onLoadStarted: () => void
  onContinue: () => void
  canContinue: boolean
  session: WechatImportSessionState
  onSessionChange: Dispatch<SetStateAction<WechatImportSessionState>>
}) {
  const [discoveries, setDiscoveries] = useState<WechatDiscoveries>(EMPTY_DISCOVERIES)
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [previewAsset, setPreviewAsset] = useState<WechatStagedAssetView | null>(null)
  const [officialAlbumDialogOpen, setOfficialAlbumDialogOpen] = useState(false)
  const [officialPreview, setOfficialPreview] = useState<WechatAccountPreviewView | null>(null)
  const [officialPreviewName, setOfficialPreviewName] = useState('')
  const [officialPreviewLoading, setOfficialPreviewLoading] = useState(false)
  const [officialPreviewError, setOfficialPreviewError] = useState<string | null>(null)
  const [selectionDialogOpen, setSelectionDialogOpen] = useState(false)
  const [stagedSelectedIds, setStagedSelectedIds] = useState<string[]>([])
  const [stagedOrderedIds, setStagedOrderedIds] = useState<string[]>([])
  const [committingSelection, setCommittingSelection] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pluginCapability, setPluginCapability] = useState<VxPluginCapability | null>(null)
  const [pluginRefreshing, setPluginRefreshing] = useState(false)
  const [pluginInstalling, setPluginInstalling] = useState(false)
  const [pluginInstallProgress, setPluginInstallProgress] =
    useState<VxPluginInstallProgress | null>(null)
  const [pluginDistribution, setPluginDistribution] = useState<VxPluginDistributionAvailability>({
    remoteInstall: false,
  })
  const {
    activeTask,
    accountPreviews,
    downloadedImport,
    officialAccount,
    officialAlbums,
    officialAlbumsLoading,
    officialAlbumsError,
    officialSelectedIds,
    officialImporting,
    downloadMode,
    progress,
    gateStatus,
  } = session

  function setSessionValue<K extends keyof WechatImportSessionState>(
    key: K,
    value:
      | WechatImportSessionState[K]
      | ((current: WechatImportSessionState[K]) => WechatImportSessionState[K]),
  ) {
    onSessionChange((current) => ({
      ...current,
      [key]:
        typeof value === 'function'
          ? (value as (current: WechatImportSessionState[K]) => WechatImportSessionState[K])(
              current[key],
            )
          : value,
    }))
  }

  const setActiveTask = (value: SetStateAction<ActiveTask | null>) =>
    setSessionValue('activeTask', value)
  const setAccountPreviews = (value: SetStateAction<Record<string, WechatAccountPreviewView>>) =>
    setSessionValue('accountPreviews', value)
  const setDownloadedImport = (value: SetStateAction<DownloadedImport | null>) =>
    setSessionValue('downloadedImport', value)
  const setOfficialAccount = (value: SetStateAction<Wechat4ImportAccountView | null>) =>
    setSessionValue('officialAccount', value)
  const setOfficialAlbums = (value: SetStateAction<Wechat4OfficialAlbumView[]>) =>
    setSessionValue('officialAlbums', value)
  const setOfficialAlbumsLoading = (value: SetStateAction<boolean>) =>
    setSessionValue('officialAlbumsLoading', value)
  const setOfficialAlbumsError = (value: SetStateAction<string | null>) =>
    setSessionValue('officialAlbumsError', value)
  const setOfficialSelectedIds = (value: SetStateAction<string[]>) =>
    setSessionValue('officialSelectedIds', value)
  const setOfficialImporting = (value: SetStateAction<boolean>) =>
    setSessionValue('officialImporting', value)
  const setDownloadMode = (value: SetStateAction<WechatDownloadMode>) =>
    setSessionValue('downloadMode', value)
  const setProgress = (value: SetStateAction<ImportProgress | null>) =>
    setSessionValue('progress', value)
  const setGateStatus = (value: SetStateAction<Wechat4GateStatus>) =>
    setSessionValue('gateStatus', value)

  async function discover(refreshedCapability?: VxPluginCapability) {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    setLoading(true)
    setError(null)
    try {
      const [capability, legacy] = await Promise.all([
        refreshedCapability ?? api.getVxPluginCapability(),
        api.discoverLegacyWechat(),
      ])
      setPluginCapability(capability)
      const current =
        capability.state === 'ready' ? await api.discoverWechat4() : EMPTY_DISCOVERIES.current
      setDiscoveries({ current, legacy })
      const accounts: WechatAccount[] = [
        ...current.accounts.map((account) => ({ kind: 'current' as const, account })),
        ...legacy.accounts.map((account) => ({ kind: 'legacy' as const, account })),
      ]
      const cached = await Promise.all(
        accounts.map(async (item) => {
          const preview = await api
            .getWechatAccountPreview(item.kind, item.account.id)
            .catch(() => undefined)
          return preview ? ([accountKey(item), preview] as const) : undefined
        }),
      )
      const cachedEntries = cached.filter((item) => item !== undefined)
      setAccountPreviews(Object.fromEntries(cachedEntries))
      const currentPreviewAccounts = new Set(
        cachedEntries
          .map(([key]) => /^current:(.+)$/.exec(key)?.[1])
          .filter((id): id is string => id !== undefined),
      )
      if (currentPreviewAccounts.size > 0) {
        setDiscoveries({
          current: {
            ...current,
            accounts: current.accounts.map((account) =>
              currentPreviewAccounts.has(account.id)
                ? { ...account, authorizationCached: true }
                : account,
            ),
          },
          legacy,
        })
      }
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function refreshPlugin() {
    const api = window.stickerApp
    if (!api || pluginRefreshing) return
    setPluginRefreshing(true)
    setError(null)
    try {
      const capability = await api.refreshVxPluginCapability()
      setPluginCapability(capability)
      await discover(capability)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setPluginRefreshing(false)
    }
  }

  async function openPluginInstallPage() {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    try {
      const opened = await api.openVxPluginInstallPage()
      if (!opened) setError('当前构建未提供组件安装页面。')
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }

  async function installPlugin(source: 'remote' | 'local') {
    const api = window.stickerApp
    if (!api || pluginInstalling) return
    setPluginInstalling(true)
    setPluginInstallProgress({
      phase: source === 'remote' ? 'checking' : 'verifying',
      message: source === 'remote' ? '正在检查可用组件' : '正在等待选择安装包',
    })
    setError(null)
    try {
      const result =
        source === 'remote'
          ? await api.installVxPluginFromRemote()
          : await api.chooseVxPluginPackage()
      if (result.canceled) {
        setPluginInstallProgress(null)
        return
      }
      setPluginCapability(result.capability)
      await discover(result.capability)
    } catch (reason) {
      setPluginInstallProgress(null)
      setError(toErrorMessage(reason))
    } finally {
      setPluginInstalling(false)
    }
  }

  useEffect(() => {
    const api = window.stickerApp
    const unsubscribeCurrentProgress = api?.onWechat4Progress(setProgress)
    const unsubscribeLegacyProgress = api?.onLegacyWechatProgress(setProgress)
    const unsubscribeGate = api?.onWechat4GateStatus(setGateStatus)
    const unsubscribePluginInstall = api?.onVxPluginInstallProgress(setPluginInstallProgress)
    void api
      ?.getVxPluginDistributionAvailability()
      .then(setPluginDistribution)
      .catch(() => undefined)
    void discover()
    return () => {
      unsubscribeCurrentProgress?.()
      unsubscribeLegacyProgress?.()
      unsubscribeGate?.()
      unsubscribePluginInstall?.()
    }
  }, [])

  function closeOfficialPreview() {
    setOfficialPreview(null)
    setOfficialPreviewName('')
    setOfficialPreviewError(null)
  }

  function selectAccount(item: WechatAccount, action: WechatAccountAction) {
    setError(null)
    if (item.kind === 'current') {
      if (item.account.authorizationCached) {
        void runCurrentAccountAction(item.account, action)
        return
      }
      setPendingAction({ account: item.account, action })
      setConfirmed(false)
      return
    }
    void runLegacyAccountAction(item, action)
  }

  function markAuthorizationCached(accountId: string) {
    setDiscoveries((current) => ({
      ...current,
      current: {
        ...current.current,
        accounts: current.current.accounts.map((account) =>
          account.id === accountId ? { ...account, authorizationCached: true } : account,
        ),
      },
    }))
  }

  async function runLegacyAccountAction(
    item: Extract<WechatAccount, { kind: 'legacy' }>,
    action: WechatAccountAction,
  ) {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    if (action === 'download') {
      onLoadStarted()
      setDownloadedImport(null)
      setOfficialAccount(null)
      setOfficialAlbums([])
      setOfficialSelectedIds([])
      setOfficialAlbumsError(null)
      setOfficialAlbumsLoading(false)
    }
    setActiveTask({ item, action })
    setProgress(null)
    try {
      if (action === 'preview') {
        const result = await api.previewLegacyWechat(item.account.id, downloadMode)
        if (result.preview) {
          setAccountPreviews((current) => ({
            ...current,
            [accountKey(item)]: result.preview!,
          }))
        }
      } else {
        const result = await api.downloadLegacyWechat(item.account.id, downloadMode)
        if (result.stagedImport) {
          if (result.stagedImport.assets.length === 0) {
            setError('下载已完成，但没有可导入的表情。')
          } else {
            setDownloadedImport({ item, stagedImport: result.stagedImport })
          }
        }
      }
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setActiveTask(null)
      setProgress(null)
      setCanceling(false)
    }
  }

  async function runCurrentAccountAction(
    directAccount?: Wechat4ImportAccountView,
    directAction?: WechatAccountAction,
  ) {
    const api = window.stickerApp
    const account = directAccount ?? pendingAction?.account
    const action = directAction ?? pendingAction?.action
    if (!api || !account || !action || (!directAccount && !confirmed)) return
    const item: WechatAccount = { kind: 'current', account }
    setPendingAction(null)
    let officialAlbumsPromise:
      ReturnType<NonNullable<typeof window.stickerApp>['listWechat4OfficialAlbums']> | undefined
    if (action === 'download') {
      onLoadStarted()
      setDownloadedImport(null)
      setOfficialAccount(item.account)
      setOfficialAlbums([])
      setOfficialSelectedIds([])
      setOfficialAlbumsError(null)
      setOfficialAlbumsLoading(true)
      if (item.account.authorizationCached) {
        officialAlbumsPromise = api.listWechat4OfficialAlbums(item.account.id)
        void officialAlbumsPromise.catch(() => undefined)
      }
    }
    setActiveTask({ item, action })
    setProgress(null)
    setError(null)
    try {
      if (action === 'preview') {
        const result = await api.previewWechat4(item.account.id, true, downloadMode)
        if (!result.canceled) markAuthorizationCached(item.account.id)
        if (result.preview) {
          setAccountPreviews((current) => ({
            ...current,
            [accountKey(item)]: result.preview!,
          }))
        }
      } else {
        const result = await api.downloadWechat4(item.account.id, true, downloadMode)
        if (!result.canceled) markAuthorizationCached(item.account.id)
        if (result.stagedImport) {
          setDownloadedImport({ item, stagedImport: result.stagedImport })
          setOfficialAccount(item.account)
          await refreshOfficialAlbums(item.account, officialAlbumsPromise)
        }
      }
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      if (action === 'download') setOfficialAlbumsLoading(false)
      setActiveTask(null)
      setProgress(null)
      setCanceling(false)
    }
  }

  async function refreshOfficialAlbums(
    account = officialAccount,
    pendingResult?: ReturnType<NonNullable<typeof window.stickerApp>['listWechat4OfficialAlbums']>,
  ) {
    const api = window.stickerApp
    if (!api || !account) return
    setOfficialAlbumsLoading(true)
    setOfficialAlbumsError(null)
    try {
      const albumResult = await (pendingResult ?? api.listWechat4OfficialAlbums(account.id))
      setOfficialAlbums(albumResult.albums)
      setOfficialSelectedIds((current) =>
        current.filter((id) => albumResult.albums.some((album) => album.packageId === id)),
      )
    } catch (reason) {
      setOfficialAlbumsError(toErrorMessage(reason))
    } finally {
      setOfficialAlbumsLoading(false)
    }
  }

  async function previewOfficialAlbum(album: Wechat4OfficialAlbumView) {
    const api = window.stickerApp
    if (!api || !officialAccount || officialPreviewLoading) return
    setOfficialPreviewLoading(true)
    setOfficialPreviewName(album.name)
    setOfficialPreview(null)
    setOfficialPreviewError(null)
    try {
      const result = await api.previewWechat4OfficialAlbum(officialAccount.id, album.packageId)
      if (result.preview?.assets.length) {
        setOfficialPreview(result.preview)
      } else {
        setOfficialPreviewError(
          '这个专辑的本地缓存当前无法读取。请重新打开对应的微信账号，进入表情面板并等待专辑加载完成，然后返回这里重新检测。',
        )
      }
    } catch {
      setOfficialPreviewError(
        '这个专辑的本地缓存当前无法读取。请重新打开对应的微信账号，进入表情面板并等待专辑加载完成，然后返回这里重新检测。',
      )
    } finally {
      setOfficialPreviewLoading(false)
    }
  }

  async function importOfficialAlbums() {
    const api = window.stickerApp
    if (!api || !officialAccount || officialSelectedIds.length === 0 || officialImporting) return
    setOfficialImporting(true)
    setError(null)
    setActiveTask({ item: { kind: 'current', account: officialAccount }, action: 'download' })
    try {
      const result = await api.importWechat4OfficialAlbums(officialAccount.id, officialSelectedIds)
      setOfficialAlbumDialogOpen(false)
      onImported(result)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setActiveTask(null)
      setProgress(null)
      setOfficialImporting(false)
    }
  }

  async function cancelImport(closeAfterCancel = false) {
    if (!activeTask) {
      if (closeAfterCancel) onClose()
      return
    }
    const api = window.stickerApp
    if (!api || canceling) return
    setCanceling(true)
    try {
      const stopped =
        activeTask.item.kind === 'current'
          ? await api.cancelWechat4Import()
          : await api.cancelLegacyWechatImport()
      if (stopped) onStopped()
      if (closeAfterCancel) onClose()
      if (!stopped) setCanceling(false)
    } catch (reason) {
      setError(toErrorMessage(reason))
      setCanceling(false)
    }
  }

  async function closePanel() {
    if (committingSelection) return
    await cancelImport(true)
  }

  async function confirmFavoritesReady() {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    try {
      const accepted = await api.confirmWechat4FavoritesReady()
      if (!accepted) setError('临时微信当前不在等待收藏表情确认。')
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }

  function openStagedImportPicker() {
    if (!downloadedImport) return
    setError(null)
    const ids = downloadedImport.stagedImport.assets.map((asset) => asset.id)
    setStagedSelectedIds(ids)
    setStagedOrderedIds(ids)
    setSelectionDialogOpen(true)
  }

  async function commitStagedImport() {
    const api = window.stickerApp
    if (!api || !downloadedImport || committingSelection || stagedSelectedIds.length === 0) return
    const selected = new Set(stagedSelectedIds)
    const orderedSelection = stagedOrderedIds.filter((id) => selected.has(id))
    setCommittingSelection(true)
    setProgress(null)
    setError(null)
    try {
      const result = await api.commitWechatStagedImport(
        downloadedImport.item.kind,
        downloadedImport.item.account.id,
        orderedSelection,
      )
      setSelectionDialogOpen(false)
      onImported(result)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setCommittingSelection(false)
      setProgress(null)
    }
  }

  const accounts: WechatAccount[] = [
    ...discoveries.current.accounts.map((account) => ({ kind: 'current' as const, account })),
    ...discoveries.legacy.accounts.map((account) => ({ kind: 'legacy' as const, account })),
  ]
  const permissionDenied =
    discoveries.current.permissionDenied || discoveries.legacy.permissionDenied
  const busy = activeTask !== null || pendingAction !== null || committingSelection
  const availableOfficialIds = officialAlbums
    .filter((album) => album.cached)
    .map((album) => album.packageId)
  const allAvailableOfficialAlbumsSelected =
    availableOfficialIds.length > 0 &&
    availableOfficialIds.every((id) => officialSelectedIds.includes(id))
  const officialAlbumBoxSelection = useBoxSelection({
    disabled: officialImporting,
    excludeSelector: '.wechat-album-card-select',
    onSelectIds: (ids) =>
      setOfficialSelectedIds((current) => [
        ...current,
        ...ids.filter((id) => !current.includes(id) && availableOfficialIds.includes(id)),
      ]),
  })
  const showTaskProgress =
    activeTask !== null &&
    (activeTask.action === 'download' ||
      (activeTask.item.kind === 'current' &&
        (gateStatus.phase === 'awaiting-qr' || gateStatus.phase === 'awaiting-favorites')))
  const showCompletedDownloads = activeTask?.action !== 'download'
  const statusLabel = officialImporting
    ? '正在导入官方表情专辑'
    : activeTask?.action === 'preview' && gateStatus.phase === 'importing'
      ? '正在生成账户预览'
      : activeTask?.action === 'download' && gateStatus.phase === 'importing'
        ? '正在整理下载结果'
        : importStatusLabel(gateStatus)

  return (
    <section className="wechat-import-panel" aria-labelledby="wechat-title">
      <div className="wechat-import-heading">
        <span className="wechat-import-icon">
          <WechatLogo size={30} weight="fill" />
        </span>
        <div>
          <h2 id="wechat-title">从微信个人收藏导入</h2>
          <p>选择一个微信账号，将个人收藏中的表情保存到我的表情库。</p>
        </div>
        <button
          type="button"
          className="panel-close"
          onClick={() => void closePanel()}
          disabled={canceling || committingSelection}
          aria-label={activeTask ? '停止当前任务并关闭' : '关闭微信导入'}
        >
          <X size={17} />
        </button>
      </div>

      {error && <p className="wechat-import-error">{error}</p>}

      {pluginCapability && pluginCapability.state !== 'ready' && (
        <div className="wechat-plugin-notice" role="note">
          <Warning size={20} weight="fill" />
          <div>
            <strong>
              {pluginCapability.state === 'missing'
                ? '新版微信导入组件尚未安装'
                : '新版微信导入组件需要更新'}
            </strong>
            <p>
              {pluginCapability.state === 'incompatible'
                ? `${pluginCapability.reason}。旧版微信导入和应用的其他功能仍可正常使用。`
                : '安装组件后可导入微信 4.x 表情；旧版微信导入和应用的其他功能仍可正常使用。'}
            </p>
            {pluginInstalling && pluginInstallProgress && (
              <div className="wechat-plugin-install-progress" aria-live="polite">
                <span>{pluginInstallProgress.message}</span>
                {pluginInstallProgress.phase === 'downloading' && (
                  <ImportProgressLine
                    completed={pluginInstallProgress.completedBytes ?? 0}
                    total={pluginInstallProgress.totalBytes ?? 0}
                  />
                )}
              </div>
            )}
          </div>
          <div className="button-row">
            {pluginDistribution.remoteInstall && (
              <button
                type="button"
                className="primary-button"
                disabled={pluginInstalling || pluginRefreshing}
                onClick={() => void installPlugin('remote')}
              >
                <DownloadSimple size={16} />
                {pluginInstalling ? '正在安装' : '下载安装'}
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={pluginInstalling || pluginRefreshing}
              onClick={() => void installPlugin('local')}
            >
              本地导入
            </button>
            {pluginCapability.installPageUrl && (
              <button
                type="button"
                className="secondary-button"
                disabled={pluginInstalling || pluginRefreshing}
                onClick={() => void openPluginInstallPage()}
              >
                安装说明
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={pluginRefreshing || pluginInstalling}
              onClick={() => void refreshPlugin()}
              aria-label={pluginRefreshing ? '正在重新检测组件' : '重新检测组件'}
              title={pluginRefreshing ? '正在重新检测组件' : '重新检测组件'}
            >
              <ArrowClockwise size={16} className={pluginRefreshing ? 'is-spinning' : undefined} />
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="wechat-import-empty">正在查找微信账号…</p>
      ) : (
        <>
          {permissionDenied && (
            <div className="wechat-permission-note" role="note">
              <Info size={19} weight="fill" />
              <div>
                <strong>需要读取其他应用的数据</strong>
                <p>请在 macOS 的系统提示中允许访问微信数据，然后重新检测账号。</p>
              </div>
              <button type="button" className="secondary-button" onClick={() => void discover()}>
                <ArrowClockwise size={16} /> 重新检测
              </button>
            </div>
          )}

          {accounts.length > 0 && (
            <>
              <DismissibleInfoNotice
                title="微信新版/旧版账户的区别"
                ariaLabel="微信新版和旧版账户的区别"
                closeLabel="关闭微信账户区别提示"
                className="wechat-version-notice"
              >
                <p>
                  新版微信账号需要打开临时微信副本并扫码；旧版微信账号只需要允许读取其他应用的数据。
                </p>
              </DismissibleInfoNotice>

              <WechatDownloadSettings
                value={downloadMode}
                disabled={busy}
                onChange={setDownloadMode}
              />

              <div className="wechat-account-list">
                {accounts.map((item) => {
                  const taskForAccount =
                    activeTask && accountKey(activeTask.item) === accountKey(item)
                      ? activeTask
                      : null
                  const preview = accountPreviews[accountKey(item)]
                  const hasPreview = Boolean(preview?.assets.length)
                  const awaitingConsent =
                    item.kind === 'current' && pendingAction?.account.id === item.account.id
                  return (
                    <Fragment key={accountKey(item)}>
                      <article className={hasPreview ? 'has-preview' : 'without-preview'}>
                        <div className="wechat-account-meta">
                          <strong>{item.account.label}</strong>
                          <span>
                            {item.kind === 'current'
                              ? `数据库 ${(item.account.databaseBytes / 1024 / 1024).toFixed(1)} MB`
                              : `${item.account.stickerCount} 张收藏表情`}
                          </span>
                        </div>
                        {hasPreview ? (
                          <>
                            <div className="wechat-account-preview-label">
                              <span className="prepared-group-status is-ready">账号预览</span>
                            </div>
                            <div className="wechat-account-preview-strip" aria-label="账户表情预览">
                              {preview?.assets.map((asset) => (
                                <button
                                  type="button"
                                  key={asset.id}
                                  title={`预览 ${asset.displayName}`}
                                  aria-label={`预览 ${asset.displayName}`}
                                  onClick={() => setPreviewAsset(asset)}
                                >
                                  <ProgressiveImage src={asset.previewUrl} alt="" eager />
                                </button>
                              ))}
                            </div>
                          </>
                        ) : null}
                        <div className="wechat-account-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy}
                            aria-busy={taskForAccount?.action === 'preview'}
                            title={
                              hasPreview ? '重新读取最多 5 张缓存图片' : '读取最多 5 张缓存图片'
                            }
                            onClick={() => selectAccount(item, 'preview')}
                          >
                            {taskForAccount?.action === 'preview'
                              ? '更新中...'
                              : hasPreview
                                ? '更新预览'
                                : '生成预览'}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => selectAccount(item, 'download')}
                          >
                            <DownloadSimple size={16} />
                            {taskForAccount?.action === 'download' ? '下载中...' : '全部加载'}
                          </button>
                        </div>
                      </article>
                      {awaitingConsent && (
                        <aside
                          className="wechat4-consent"
                          role="dialog"
                          aria-labelledby={`wechat-consent-title-${item.account.id}`}
                        >
                          <div className="wechat4-consent-title">
                            <Warning size={20} weight="fill" />
                            <div>
                              <strong id={`wechat-consent-title-${item.account.id}`}>
                                确认临时微信授权
                              </strong>
                              <span>{item.account.label}</span>
                            </div>
                          </div>
                          <ul>
                            <li>开始前，应用可能需要先退出当前微信。</li>
                            <li>应用只会复制并运行临时微信副本，不会修改原微信应用。</li>
                            <li>你需要在临时微信中扫码，并打开一次收藏表情面板。</li>
                            <li>临时登录可能会退出原 Mac 会话，任务结束后会重新打开原微信。</li>
                          </ul>
                          <label className="wechat4-confirm-check">
                            <input
                              type="checkbox"
                              checked={confirmed}
                              onChange={(event) => setConfirmed(event.target.checked)}
                            />
                            <span>我了解上述流程，并同意在需要时运行临时微信副本。</span>
                          </label>
                          <div className="button-row">
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => setPendingAction(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="primary-button"
                              disabled={!confirmed}
                              onClick={() => void runCurrentAccountAction()}
                            >
                              <ShieldCheck size={16} />
                              {pendingAction?.action === 'preview' ? '确认并预览' : '确认并开始'}
                            </button>
                          </div>
                        </aside>
                      )}
                    </Fragment>
                  )
                })}
              </div>
            </>
          )}

          {!permissionDenied && accounts.length === 0 && (
            <div className="wechat-import-empty">
              <p>
                {pluginCapability?.state === 'ready'
                  ? '没有找到可读取的微信个人收藏。请先登录微信并打开一次收藏表情，然后重新检测。'
                  : '没有找到可读取的旧版微信个人收藏。安装新版微信导入组件后，可继续检测微信 4.x 账号。'}
              </p>
              <button type="button" className="secondary-button" onClick={() => void discover()}>
                <ArrowClockwise size={16} /> 重新检测
              </button>
            </div>
          )}
        </>
      )}

      {activeTask && showTaskProgress && (
        <div
          className={`wechat-import-progress${
            activeTask.item.kind === 'current' ? ` wechat4-gate-${gateStatus.phase}` : ''
          }`}
          aria-live="polite"
        >
          <div>
            <span>
              {activeTask.item.kind === 'current'
                ? statusLabel
                : progress?.phase === 'importing'
                  ? activeTask.action === 'preview'
                    ? '生成账户预览'
                    : '验证并导入图片'
                  : '下载图片'}
            </span>
            <span>{progress ? `${progress.completed} / ${progress.total}` : '准备中'}</span>
          </div>
          <ImportProgressLine
            completed={progress?.completed ?? 0}
            total={progress?.total ?? 0}
            fallbackPercent={
              activeTask.item.kind === 'current' && gateStatus.phase === 'awaiting-qr' ? 45 : 8
            }
          />
          {activeTask.item.kind === 'current' && gateStatus.phase === 'awaiting-qr' ? (
            <p>请在临时微信窗口扫码登录，然后打开收藏表情面板。</p>
          ) : activeTask.item.kind === 'current' && gateStatus.phase === 'awaiting-favorites' ? (
            <div className="wechat4-favorites-ready">
              <p>请等到临时微信中的收藏表情缩略图显示出来，再继续导入。</p>
              <button
                type="button"
                className="primary-button"
                onClick={() => void confirmFavoritesReady()}
              >
                <CheckCircle size={16} /> 收藏表情已显示，继续导入
              </button>
            </div>
          ) : progress ? (
            <div className="wechat-import-summary">
              <p>
                新增 {progress.imported}，重复 {progress.duplicates}，失败 {progress.failed}
              </p>
              <button
                type="button"
                className="text-button danger-text"
                disabled={canceling}
                onClick={() => void cancelImport()}
              >
                {canceling ? '正在取消' : '取消本次导入'}
              </button>
            </div>
          ) : activeTask.item.kind === 'current' ? (
            <p>{gateStatus.message}</p>
          ) : (
            <p>正在准备导入…</p>
          )}
          {activeTask.action === 'download' &&
            (activeTask.item.kind === 'current' ? (
              <p className="wechat-official-loading-note">
                <ArrowClockwise size={14} className="is-spinning" />
                正在加载微信表情合集
              </p>
            ) : (
              <p className="wechat-official-loading-note is-unsupported">
                官方表情专辑需要升级本机微信版本后（4.0 以上）才能获取。
              </p>
            ))}
        </div>
      )}

      {downloadedImport && showCompletedDownloads && (
        <div className="wechat-download-ready" aria-live="polite">
          <span>
            <CheckCircle size={17} weight="fill" />
            <strong>个人收藏下载成功</strong>
            <small>{downloadedImport.stagedImport.assets.length} 张个人收藏表情可供选择</small>
          </span>
          <button
            type="button"
            className="primary-button"
            disabled={busy || downloadedImport.stagedImport.assets.length === 0}
            onClick={openStagedImportPicker}
          >
            选择导入表情
          </button>
        </div>
      )}

      {downloadedImport?.item.kind === 'current' && showCompletedDownloads && (
        <div className="wechat-download-ready wechat-official-ready" aria-live="polite">
          <span>
            {officialAlbumsLoading ? (
              <ArrowClockwise size={17} className="is-spinning" />
            ) : officialAlbumsError ? (
              <Warning size={17} weight="fill" />
            ) : (
              <CheckCircle size={17} weight="fill" />
            )}
            <strong>
              {officialAlbumsLoading
                ? '正在读取表情专辑'
                : officialAlbumsError
                  ? '表情专辑读取失败'
                  : '表情专辑下载成功'}
            </strong>
            <small>
              {officialAlbumsLoading
                ? '正在获取专辑名称和封面'
                : (officialAlbumsError ?? `共 ${officialAlbums.length} 个专辑可供选择`)}
            </small>
          </span>
          <button
            type="button"
            className="primary-button"
            disabled={
              busy || officialAlbumsLoading || (!officialAlbumsError && officialAlbums.length === 0)
            }
            onClick={() => {
              if (officialAlbumsError) void refreshOfficialAlbums()
              else setOfficialAlbumDialogOpen(true)
            }}
          >
            {officialAlbumsError ? '重新读取' : '选择导入专辑'}
          </button>
        </div>
      )}

      {downloadedImport?.item.kind === 'legacy' && showCompletedDownloads && (
        <p className="wechat-official-unsupported">
          官方表情专辑需要升级本机微信版本后（4.0 以上）才能获取。
        </p>
      )}

      {!pendingAction && accounts.length > 0 ? (
        <p className="wechat4-privacy-note">
          <CheckCircle size={15} /> 微信数据只在本机读取和处理。
        </p>
      ) : null}

      {canContinue && !activeTask && !pendingAction && (
        <div className="wechat-import-next-step">
          <span>
            <strong>本次导入结果已保留</strong>
            <small>你可以继续导入其它内容，或前往下一步选择目的地。</small>
          </span>
          <button type="button" className="primary-button" onClick={onContinue}>
            下一步
            <ArrowRight size={16} />
          </button>
        </div>
      )}

      {previewAsset && (
        <StickerImagePreviewDialog asset={previewAsset} onClose={() => setPreviewAsset(null)} />
      )}

      {officialAlbumDialogOpen && officialAccount && (
        <Dialog
          className="wechat-import-picker-dialog wechat-album-picker-dialog"
          backdropClassName="wechat-picker-backdrop"
          surfaceAs="section"
          ariaLabelledBy="wechat-album-picker-title"
          portal
          closeOnBackdrop={!officialImporting}
          closeOnEscape={!officialImporting && !officialPreviewName}
          onClose={() => setOfficialAlbumDialogOpen(false)}
        >
          <header>
            <div>
              <h2 id="wechat-album-picker-title">选择导入专辑</h2>
              <p>按专辑选择，导入时会保存专辑内的全部表情。</p>
            </div>
            <button
              type="button"
              className="panel-close"
              aria-label="关闭专辑选择器"
              disabled={officialImporting}
              onClick={() => setOfficialAlbumDialogOpen(false)}
            >
              <X size={17} />
            </button>
          </header>
          <div className="wechat-album-list">
            {error && <p className="wechat-import-error wechat-picker-error">{error}</p>}
            <div className="wechat-album-cache-note" role="note">
              <span>
                专辑来自本机微信缓存。如果数量不完整，请先在微信表情面板浏览并等待加载，再重新检测。
              </span>
              <button
                type="button"
                className="text-button"
                disabled={officialAlbumsLoading || officialImporting}
                onClick={() => void refreshOfficialAlbums()}
              >
                <ArrowClockwise size={15} />
                {officialAlbumsLoading ? '正在检测' : '重新检测'}
              </button>
            </div>
            <div
              className="wechat-album-grid"
              ref={officialAlbumBoxSelection.gridRef}
              onPointerDown={officialAlbumBoxSelection.onPointerDown}
              onClickCapture={officialAlbumBoxSelection.onClickCapture}
              onDragStart={(event) => event.preventDefault()}
            >
              <div
                className="box-selection-marquee"
                ref={officialAlbumBoxSelection.marqueeRef}
                hidden
                aria-hidden="true"
              />
              {officialAlbums.map((album) => {
                const checked = officialSelectedIds.includes(album.packageId)
                return (
                  <article
                    key={album.packageId}
                    className={`wechat-album-card${checked ? ' is-selected' : ''}${
                      !album.cached ? ' is-unavailable' : ''
                    }`}
                    data-box-selection-id={album.cached ? album.packageId : undefined}
                  >
                    <button
                      type="button"
                      className="wechat-album-card-preview"
                      disabled={!album.cached || officialPreviewLoading}
                      aria-label={`查看 ${album.name} 的全部表情`}
                      title={album.cached ? `查看 ${album.name}` : `${album.name} 尚未载入本机`}
                      onClick={() => void previewOfficialAlbum(album)}
                    >
                      <span className="wechat-album-card-cover">
                        {album.cover ? (
                          <ProgressiveImage
                            src={album.cover.previewUrl}
                            alt={`${album.name}封面`}
                          />
                        ) : (
                          <span className="wechat-album-card-cover-empty" aria-label="缓存待刷新">
                            缓存待刷新
                          </span>
                        )}
                      </span>
                      <span className="wechat-album-card-meta">
                        <strong title={album.name}>{album.name}</strong>
                        <small>
                          {album.stickerCount} 张表情{album.cached ? '' : ' · 尚未载入本机'}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="wechat-album-card-select"
                      aria-label={`${checked ? '取消选择' : '选择'} ${album.name}`}
                      aria-pressed={checked}
                      disabled={!album.cached || officialImporting}
                      onClick={(event) => {
                        event.stopPropagation()
                        setOfficialSelectedIds((current) =>
                          current.includes(album.packageId)
                            ? current.filter((id) => id !== album.packageId)
                            : [...current, album.packageId],
                        )
                      }}
                    >
                      {checked && <Check size={15} weight="bold" />}
                    </button>
                  </article>
                )
              })}
            </div>
          </div>
          <footer>
            <div className="wechat-album-selection-summary">
              <button
                type="button"
                className="text-button"
                disabled={
                  officialImporting ||
                  availableOfficialIds.length === 0 ||
                  allAvailableOfficialAlbumsSelected
                }
                onClick={() => setOfficialSelectedIds(availableOfficialIds)}
              >
                全选可用专辑
              </button>
              <span>
                已选择 {officialSelectedIds.length} 个专辑
                <small>拖过卡片可框选多个专辑</small>
              </span>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                disabled={officialImporting || officialSelectedIds.length === 0}
                onClick={() => setOfficialSelectedIds([])}
              >
                取消当前选择
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={officialImporting || officialSelectedIds.length === 0}
                onClick={() => void importOfficialAlbums()}
              >
                {officialImporting ? '正在导入...' : `导入 ${officialSelectedIds.length} 个专辑`}
              </button>
            </div>
          </footer>
        </Dialog>
      )}

      {(officialPreviewLoading || officialPreview || officialPreviewError) &&
        officialPreviewName && (
          <Dialog
            className="wechat-album-preview-dialog"
            backdropClassName="wechat-album-preview-backdrop"
            surfaceAs="section"
            ariaLabelledBy="wechat-album-preview-title"
            portal
            closeOnBackdrop={!officialPreviewLoading}
            closeOnEscape={!officialPreviewLoading}
            onClose={closeOfficialPreview}
          >
            <header>
              <div>
                <h2 id="wechat-album-preview-title">{officialPreviewName}</h2>
                <p>
                  {officialPreview
                    ? `${officialPreview.assets.length} 张表情`
                    : officialPreviewError
                      ? '暂时无法读取专辑内容'
                      : '正在读取专辑内容'}
                </p>
              </div>
              <button
                type="button"
                className="panel-close"
                aria-label="关闭专辑预览"
                disabled={officialPreviewLoading}
                onClick={closeOfficialPreview}
              >
                <X size={17} />
              </button>
            </header>
            {officialPreviewLoading ? (
              <p className="wechat-album-preview-loading">
                <ArrowClockwise size={15} className="is-spinning" />
                正在加载本地专辑内容...
              </p>
            ) : officialPreviewError ? (
              <div className="wechat-album-preview-error" role="alert">
                <Warning size={20} weight="fill" />
                <div>
                  <strong>缓存出现问题，请重新打开微信</strong>
                  <p>{officialPreviewError}</p>
                </div>
              </div>
            ) : (
              <div className="wechat-album-preview-grid">
                {officialPreview?.assets.map((asset) => (
                  <div className="wechat-album-preview-item" key={asset.id}>
                    <ProgressiveImage src={asset.previewUrl} alt={asset.displayName} />
                  </div>
                ))}
              </div>
            )}
          </Dialog>
        )}

      {selectionDialogOpen && downloadedImport && (
        <Dialog
          className="wechat-import-picker-dialog"
          backdropClassName="wechat-picker-backdrop"
          surfaceAs="section"
          ariaLabelledBy="wechat-picker-title"
          portal
          closeOnBackdrop={!committingSelection}
          closeOnEscape={!committingSelection}
          onClose={() => setSelectionDialogOpen(false)}
        >
          <header>
            <div>
              <h2 id="wechat-picker-title">选择导入表情</h2>
              <p>筛选并勾选要保存到“我的表情库”的内容。</p>
            </div>
            <button
              type="button"
              className="panel-close"
              aria-label="关闭表情选择器"
              disabled={committingSelection}
              onClick={() => setSelectionDialogOpen(false)}
            >
              <X size={17} />
            </button>
          </header>
          <div
            className={`wechat-import-picker-content${committingSelection ? ' is-committing' : ''}`}
            aria-busy={committingSelection}
            inert={committingSelection}
          >
            {error && <p className="wechat-import-error wechat-picker-error">{error}</p>}
            <StickerPicker
              assets={downloadedImport.stagedImport.assets}
              selectedIds={stagedSelectedIds}
              orderedIds={stagedOrderedIds}
              mode="export"
              toolbar="wechat-import"
              allowCopy={false}
              onSelection={setStagedSelectedIds}
              onOrder={setStagedOrderedIds}
            />
          </div>
          <footer className="wechat-import-picker-footer">
            <span>已选择 {stagedSelectedIds.length} 张</span>
            {committingSelection && (
              <div className="wechat-import-picker-progress" aria-live="polite">
                <span>
                  正在保存到素材库
                  <strong>
                    {progress?.completed ?? 0} / {progress?.total ?? stagedSelectedIds.length}
                  </strong>
                </span>
                <ImportProgressLine
                  completed={progress?.completed ?? 0}
                  total={progress?.total ?? stagedSelectedIds.length}
                />
              </div>
            )}
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                disabled={committingSelection}
                onClick={() => setSelectionDialogOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={committingSelection || stagedSelectedIds.length === 0}
                onClick={() => void commitStagedImport()}
              >
                {committingSelection ? '正在导入...' : `导入 ${stagedSelectedIds.length} 张表情`}
              </button>
            </div>
          </footer>
        </Dialog>
      )}
    </section>
  )
}
