import makeWASocket, {
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  type WASocket,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import QRCode from 'qrcode'

import type {
  SendPackProgress,
  SendPackReceipt,
  WhatsAppConnectionView,
  WhatsAppCredentialMode,
  WhatsAppTarget,
} from '../../shared/domain.js'
import { isWhatsAppConnectionActive } from '../../shared/whatsapp-connection.js'
import type { PreparedPack } from '../packs/pack-preparer.js'
import { hasPairedCredentials } from './auth-store.js'
import { CredentialAuthStore } from './credential-auth-store.js'
import { sendPreparedStickerPack } from './native-pack.js'
import { SendReceiptStore } from './send-receipt-store.js'

const logger = pino({ level: 'silent' })

function disconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const output = 'output' in error ? error.output : undefined
  if (!output || typeof output !== 'object' || !('statusCode' in output)) return undefined
  return typeof output.statusCode === 'number' ? output.statusCode : undefined
}

export class WhatsAppManager {
  private socket: WASocket | undefined
  private view: WhatsAppConnectionView = {
    phase: 'disconnected',
    hasSession: false,
    credentialMode: 'keychain',
    canChangeCredentialMode: true,
  }
  private intentionalClose = false
  private allowedGroupIds = new Set<string>()
  private sentReceipts = new Map<string, string>()

  constructor(
    private readonly authStore: CredentialAuthStore,
    private readonly receiptStore: SendReceiptStore,
    private readonly onStatus: (view: WhatsAppConnectionView) => void,
  ) {}

  async initialize(): Promise<void> {
    try {
      await this.authStore.initialize()
      this.update({ phase: 'disconnected', hasSession: await this.authStore.hasSession() })
    } catch (error) {
      this.update({
        phase: 'error',
        hasSession: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  getStatus(): WhatsAppConnectionView {
    return this.view
  }

  private update(
    next: Omit<WhatsAppConnectionView, 'credentialMode' | 'canChangeCredentialMode'>,
  ): void {
    this.view = {
      ...next,
      credentialMode: this.authStore.getMode(),
      canChangeCredentialMode: !next.hasSession && !isWhatsAppConnectionActive(next.phase),
    }
    this.onStatus(this.view)
  }

  async setCredentialMode(mode: WhatsAppCredentialMode): Promise<WhatsAppConnectionView> {
    if (this.socket || isWhatsAppConnectionActive(this.view.phase)) {
      throw new Error('请先断开 WhatsApp 连接，再切换凭证存储方式')
    }
    await this.authStore.setMode(mode)
    this.update({
      phase: this.view.phase === 'logged-out' ? 'logged-out' : 'disconnected',
      hasSession: false,
      message:
        mode === 'keychain'
          ? '将使用 macOS 钥匙串保护登录凭证，安全性较高'
          : '将使用本地明文文件保存登录凭证，可避免授权，但安全性可能较低',
    })
    return this.view
  }

  private selfTarget(socket = this.socket): WhatsAppTarget | undefined {
    if (!socket?.user?.id) return undefined
    return { id: jidNormalizedUser(socket.user.id), name: '给自己发', kind: 'self' }
  }

  async connect(pairingPhone?: string): Promise<WhatsAppConnectionView> {
    if (isWhatsAppConnectionActive(this.view.phase)) {
      return this.view
    }
    const phone = pairingPhone?.replace(/\D/g, '')
    if (pairingPhone !== undefined && phone!.length < 8) {
      throw new Error('请输入包含国家/地区代码的完整手机号，例如 85212345678')
    }
    this.intentionalClose = false
    try {
      await this.openSocket(phone)
    } catch (error) {
      this.socket?.end(undefined)
      this.socket = undefined
      let hasSession = false
      try {
        hasSession = await this.authStore.hasSession()
      } catch {
        // The original connection error is more useful than a second storage error here.
      }
      this.update({
        phase: 'error',
        hasSession,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return this.view
  }

  private async openSocket(
    pairingPhone?: string,
    browserMode: 'qr' | 'phone' = pairingPhone ? 'phone' : 'qr',
  ): Promise<void> {
    const { state, saveCreds } = await this.authStore.load()
    const hasSession = hasPairedCredentials(state.creds)
    this.update({
      phase: 'connecting',
      hasSession,
      message: hasSession ? '正在复用已保存的 session…' : '正在建立连接…',
    })

    const browser = browserMode === 'phone' ? Browsers.macOS('Chrome') : Browsers.macOS('Desktop')
    const socket = makeWASocket({
      auth: state,
      browser,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })
    this.socket = socket
    this.allowedGroupIds.clear()

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds()
      } catch (error) {
        this.update({
          phase: 'error',
          hasSession: false,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })

    socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (this.socket !== socket) return
      try {
        if (qr && !pairingPhone && !hasSession) {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 560,
            margin: 2,
            errorCorrectionLevel: 'M',
          })
          if (this.socket === socket && this.view.phase !== 'connected') {
            this.update({ phase: 'awaiting-qr', hasSession: false, qrDataUrl })
          }
        }

        if (connection === 'open') {
          await saveCreds()
          this.update({
            phase: 'connected',
            hasSession: true,
            selfTarget: this.selfTarget(socket),
          })
        }

        if (connection === 'close') {
          if (this.intentionalClose) return
          this.socket = undefined
          const code = disconnectStatusCode(lastDisconnect?.error)
          if (code === DisconnectReason.restartRequired) {
            this.update({
              phase: 'reconnecting',
              hasSession: true,
              message: '关联完成，正在复用新登录凭证重新连接…',
            })
            await this.openSocket(undefined, browserMode)
          } else if (code === DisconnectReason.loggedOut) {
            await this.authStore.clear()
            this.update({
              phase: 'logged-out',
              hasSession: false,
              message: 'WhatsApp 已注销此设备，请重新关联。',
            })
          } else {
            this.update({
              phase: 'error',
              hasSession: await this.authStore.hasSession(),
              message: code ? `WhatsApp 连接已断开（${code}）` : 'WhatsApp 连接已断开',
            })
          }
        }
      } catch (error) {
        this.update({
          phase: 'error',
          hasSession: await this.authStore.hasSession(),
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })

    if (pairingPhone && !hasSession) {
      // requestPairingCode must be sent after the noise handshake completes,
      // otherwise Baileys' sendRawMessage rejects with "Connection Closed".
      // `qr` is only emitted once the transport is ready, so wait for it.
      await socket.waitForConnectionUpdate(async (update) => update.qr !== undefined)
      const pairingCode = await socket.requestPairingCode(pairingPhone)
      this.update({ phase: 'awaiting-pairing-code', hasSession: false, pairingCode })
    }
  }

  async disconnect(): Promise<WhatsAppConnectionView> {
    this.intentionalClose = true
    const socket = this.socket
    this.socket = undefined
    socket?.end(undefined)
    this.allowedGroupIds.clear()
    const hasSession = await this.authStore.hasSession()
    this.update({
      phase: 'disconnected',
      hasSession,
      message: hasSession ? '连接已断开；session 仍保留在本机。' : '连接已取消。',
    })
    return this.view
  }

  async logout(): Promise<WhatsAppConnectionView> {
    this.intentionalClose = true
    const socket = this.socket
    this.socket = undefined
    if (socket) await socket.logout().catch(() => undefined)
    await this.authStore.clear()
    this.allowedGroupIds.clear()
    this.update({ phase: 'logged-out', hasSession: false, message: '本地登录已安全清除。' })
    return this.view
  }

  async listGroups(): Promise<WhatsAppTarget[]> {
    const socket = this.socket
    if (!socket || this.view.phase !== 'connected') throw new Error('请先连接 WhatsApp')
    const groups = Object.values(await socket.groupFetchAllParticipating())
      .map<WhatsAppTarget>((group) => ({
        id: group.id,
        name: group.subject.trim() || '未命名群聊',
        kind: 'group',
        participantCount: group.participants.length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
    this.allowedGroupIds = new Set(groups.map((group) => group.id))
    return groups
  }

  async sendPacks(
    targetId: string,
    packs: PreparedPack[],
    onProgress: (progress: SendPackProgress) => void,
  ): Promise<SendPackReceipt[]> {
    const socket = this.socket
    if (!socket || this.view.phase !== 'connected') throw new Error('请先连接 WhatsApp')
    const selfId = this.selfTarget(socket)?.id
    if (targetId !== selfId && !this.allowedGroupIds.has(targetId)) {
      throw new Error('请选择“给自己发”，或先读取并选择一个群聊')
    }

    const receipts: SendPackReceipt[] = []
    for (const [index, pack] of packs.entries()) {
      const receiptKey = `${targetId}|${pack.id}`
      const existingMessageId =
        this.sentReceipts.get(receiptKey) ??
        (await this.receiptStore.getMessageId(targetId, pack.id))
      if (existingMessageId) {
        onProgress({
          packId: pack.id,
          packName: pack.name,
          packIndex: index + 1,
          packCount: packs.length,
          status: 'skipped',
          message: '本次运行中已经发送成功，已跳过',
        })
        receipts.push({
          packId: pack.id,
          packName: pack.name,
          status: 'skipped',
          messageId: existingMessageId,
        })
        continue
      }

      onProgress({
        packId: pack.id,
        packName: pack.name,
        packIndex: index + 1,
        packCount: packs.length,
        status: 'uploading',
      })
      try {
        const messageId = await sendPreparedStickerPack(socket, targetId, pack)
        this.sentReceipts.set(receiptKey, messageId)
        let receiptWarning: string | undefined
        try {
          await this.receiptStore.record(targetId, pack.id, messageId)
        } catch {
          receiptWarning = '已发送，但发送记录未能保存；本次运行中不会重复发送'
        }
        onProgress({
          packId: pack.id,
          packName: pack.name,
          packIndex: index + 1,
          packCount: packs.length,
          status: 'sent',
          message: receiptWarning,
        })
        receipts.push({ packId: pack.id, packName: pack.name, status: 'sent', messageId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        onProgress({
          packId: pack.id,
          packName: pack.name,
          packIndex: index + 1,
          packCount: packs.length,
          status: 'failed',
          message,
        })
        receipts.push({ packId: pack.id, packName: pack.name, status: 'failed', error: message })
      }
    }
    return receipts
  }
}
