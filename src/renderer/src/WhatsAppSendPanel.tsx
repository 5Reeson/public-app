import { useEffect, useMemo, useState } from 'react'
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise'
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/MagnifyingGlass'
import { PaperPlaneTiltIcon as PaperPlaneTilt } from '@phosphor-icons/react/PaperPlaneTilt'
import { SignOutIcon as SignOut } from '@phosphor-icons/react/SignOut'
import { UserCircleIcon as UserCircle } from '@phosphor-icons/react/UserCircle'
import { UsersThreeIcon as UsersThree } from '@phosphor-icons/react/UsersThree'
import { WhatsappLogoIcon as WhatsappLogo } from '@phosphor-icons/react/WhatsappLogo'

import type {
  PreparedPackView,
  SendPackProgress,
  SendPackReceipt,
  WhatsAppConnectionView,
  WhatsAppTarget,
} from '../../shared/domain.js'
import { toErrorMessage } from '../../shared/errors.js'
import { whatsAppConnectionLabel } from '../../shared/whatsapp-connection.js'
import { WhatsAppConnectionControls } from './components/WhatsAppConnectionControls.js'
import { useWhatsAppConnectionController } from './components/useWhatsAppConnectionController.js'

interface WhatsAppSendPanelProps {
  connection: WhatsAppConnectionView
  expectedPackCount: number
  preparedPacks: PreparedPackView[]
  selectedPackIds: string[]
  onConnectionChange(status: WhatsAppConnectionView): void
  onError(message: string): void
  onSent?(): void
}

export function WhatsAppSendPanel({
  connection,
  expectedPackCount,
  preparedPacks,
  selectedPackIds,
  onConnectionChange,
  onError,
  onSent,
}: WhatsAppSendPanelProps) {
  const [groups, setGroups] = useState<WhatsAppTarget[] | null>(null)
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupSearch, setGroupSearch] = useState('')
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendProgress, setSendProgress] = useState<Record<string, SendPackProgress>>({})
  const [receipts, setReceipts] = useState<Record<string, SendPackReceipt>>({})
  const connectionController = useWhatsAppConnectionController({
    connection,
    onConnectionChange,
    onError,
  })

  const packSignature = preparedPacks.map((pack) => `${pack.id}:${pack.status}`).join('|')
  const selectedPacks = preparedPacks.filter((pack) => selectedPackIds.includes(pack.id))
  const selectedPackCount = selectedPacks.length
  const readyToSend =
    selectedPackIds.length > 0 &&
    preparedPacks.length === expectedPackCount &&
    selectedPackCount === selectedPackIds.length &&
    selectedPacks.every((pack) => pack.status === 'prepared')
  const filteredGroups = useMemo(() => {
    const query = groupSearch.trim().toLocaleLowerCase('zh-Hans-CN')
    return query
      ? (groups ?? []).filter((group) => group.name.toLocaleLowerCase('zh-Hans-CN').includes(query))
      : (groups ?? [])
  }, [groupSearch, groups])
  const selectedTarget =
    selectedTargetId === connection.selfTarget?.id
      ? connection.selfTarget
      : groups?.find((group) => group.id === selectedTargetId)
  const failedPackIds = selectedPacks
    .filter((pack) => receipts[pack.id]?.status === 'failed')
    .map((pack) => pack.id)
  const sentCount = selectedPacks.filter((pack) =>
    ['sent', 'skipped'].includes(receipts[pack.id]?.status ?? ''),
  ).length

  useEffect(() => {
    const api = window.stickerApp
    if (!api) return
    const unsubscribeProgress = api.onSendPackProgress((progress) => {
      setSendProgress((current) => ({ ...current, [progress.packId]: progress }))
    })
    return unsubscribeProgress
  }, [])

  useEffect(() => {
    if (connection.phase === 'connected' && connection.selfTarget) {
      setSelectedTargetId((current) => current ?? connection.selfTarget!.id)
    }
    if (connection.phase !== 'connected') {
      setSelectedTargetId(null)
      setGroups(null)
      setGroupSearch('')
    }
  }, [connection.phase, connection.selfTarget])

  useEffect(() => {
    setSendProgress({})
    setReceipts({})
  }, [packSignature])

  async function loadGroups() {
    const api = window.stickerApp
    if (!api) return
    setGroupsLoading(true)
    try {
      setGroups(await api.listWhatsAppGroups())
    } catch (error) {
      onError(toErrorMessage(error))
    } finally {
      setGroupsLoading(false)
    }
  }

  async function send(packIds?: string[]) {
    const api = window.stickerApp
    if (!api || !selectedTargetId) return
    setSending(true)
    if (!packIds) {
      setSendProgress({})
      setReceipts({})
    }
    try {
      const result = await api.sendWhatsAppPacks(selectedTargetId, packIds)
      setReceipts((current) => ({
        ...current,
        ...Object.fromEntries(result.receipts.map((receipt) => [receipt.packId, receipt])),
      }))
      onSent?.()
    } catch (error) {
      onError(toErrorMessage(error))
    } finally {
      setSending(false)
    }
  }

  const connected = connection.phase === 'connected'

  return (
    <section className="whatsapp-panel" aria-labelledby="whatsapp-panel-title">
      <div className="whatsapp-heading">
        <div>
          <p className="section-label">最后一步</p>
          <h2 id="whatsapp-panel-title">发送到 WhatsApp</h2>
          <p>默认发给你自己。只有你主动点击按钮后，才会加载更多可用的 WhatsApp 群聊。</p>
        </div>
        <span className={`connection-pill ${connection.phase}`}>
          <span /> {whatsAppConnectionLabel(connection.phase)}
        </span>
      </div>

      {!connected && (
        <div className="connection-card">
          <div className="connection-copy">
            <span className="connection-icon">
              <WhatsappLogo size={25} weight="light" />
            </span>
            <div>
              <strong>{connection.hasSession ? '复用已保存的登录' : '连接你的 WhatsApp'}</strong>
              <p>
                {connection.message ??
                  (connection.hasSession
                    ? connection.credentialMode === 'keychain'
                      ? '登录凭证由 macOS 钥匙串保护；连接后通常无需再次扫码。'
                      : '登录凭证保存在权限受限的本地明文文件；连接后通常无需再次扫码。'
                    : '首次关联前请选择登录凭证的本机存储方式。')}
              </p>
            </div>
          </div>

          <WhatsAppConnectionControls
            connection={connection}
            controller={connectionController}
            variant="card"
          />
        </div>
      )}

      {connected && connection.selfTarget && (
        <div className="target-picker">
          <div className="target-picker-heading">
            <div>
              <strong>发送目标</strong>
              <p>为保护隐私，不会自动读取 WhatsApp 联系人及群聊。</p>
            </div>
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={groupsLoading}
              onClick={loadGroups}
            >
              {groupsLoading ? (
                <ArrowClockwise className="is-spinning" size={15} />
              ) : (
                <UsersThree size={15} />
              )}
              {groups === null ? '读取其他群聊' : '刷新群聊'}
            </button>
          </div>

          <button
            className={`target-option self-target${selectedTargetId === connection.selfTarget.id ? ' is-selected' : ''}`}
            type="button"
            onClick={() => setSelectedTargetId(connection.selfTarget!.id)}
          >
            <span className="target-avatar">
              <UserCircle size={21} />
            </span>
            <span>
              <strong>给自己发</strong>
              <small>默认选项 · 仅发送到你自己的聊天</small>
            </span>
            <span className="target-radio" />
          </button>

          {groups !== null && (
            <div className="group-picker">
              <label className="group-search">
                <MagnifyingGlass size={15} />
                <input
                  type="search"
                  placeholder="搜索群聊"
                  value={groupSearch}
                  onChange={(event) => setGroupSearch(event.target.value)}
                />
              </label>
              <div className="group-list">
                {filteredGroups.map((group) => (
                  <button
                    className={`target-option${selectedTargetId === group.id ? ' is-selected' : ''}`}
                    type="button"
                    key={group.id}
                    onClick={() => setSelectedTargetId(group.id)}
                  >
                    <span className="target-avatar">
                      <UsersThree size={19} />
                    </span>
                    <span>
                      <strong>{group.name}</strong>
                      <small>{group.participantCount ?? 0} 位成员</small>
                    </span>
                    <span className="target-radio" />
                  </button>
                ))}
                {filteredGroups.length === 0 && (
                  <p className="group-empty">
                    {groups.length === 0 ? '没有可用群聊。' : '没有匹配的群聊。'}
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="send-footer">
            <div className="send-summary">
              <strong>{selectedTarget?.name ?? '请选择发送目标'}</strong>
              <p>
                {selectedPackCount === 0
                  ? '请在传输预览中至少选择一个表情包。'
                  : !readyToSend
                    ? '请先点击上方“准备传输”完成表情转换。'
                    : sending
                      ? '正在逐包上传，请保持应用打开。'
                      : sentCount === selectedPackCount
                        ? '所选 WhatsApp 原生贴纸包已发送，请回到手机逐包添加。'
                        : `准备发送 ${selectedPackCount} 个 WhatsApp 原生贴纸包。`}
              </p>
            </div>
            {failedPackIds.length > 0 ? (
              <button
                className="secondary-button"
                type="button"
                disabled={sending}
                onClick={() => send(failedPackIds)}
              >
                <ArrowClockwise size={16} /> 重试失败的 {failedPackIds.length} 个包
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={
                  !readyToSend || !selectedTarget || sending || sentCount === selectedPackCount
                }
                onClick={() => send(selectedPackIds)}
              >
                <PaperPlaneTilt size={16} />
                {sending ? '正在发送' : `发送 ${selectedPackCount} 个表情包`}
              </button>
            )}
          </div>

          {Object.keys(sendProgress).length > 0 && (
            <div className="send-progress-list" aria-live="polite">
              {preparedPacks.map((pack) => {
                const progress = sendProgress[pack.id]
                if (!progress) return null
                return (
                  <div key={pack.id} className={progress.status}>
                    {progress.status === 'sent' || progress.status === 'skipped' ? (
                      <CheckCircle size={16} weight="fill" />
                    ) : progress.status === 'failed' ? (
                      <ArrowClockwise size={16} />
                    ) : (
                      <span className="progress-spinner" />
                    )}
                    <span>
                      <strong>{pack.name}</strong>
                      <small>
                        {progress.message ??
                          (progress.status === 'uploading'
                            ? '正在上传 WhatsApp 原生贴纸包…'
                            : '发送成功')}
                      </small>
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="whatsapp-session-actions">
            <span>免责声明：非官方 WhatsApp 集成；WhatsApp 版本更新可能导致此功能暂时不可用。</span>
            <div>
              <button
                className="text-button"
                type="button"
                disabled={connectionController.busy || sending}
                onClick={() => void connectionController.disconnect()}
              >
                断开本次连接
              </button>
              <button
                className="text-button danger-text"
                type="button"
                disabled={connectionController.busy || sending}
                onClick={() => void connectionController.logout()}
              >
                <SignOut size={14} /> 登出并清除登录凭证
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
