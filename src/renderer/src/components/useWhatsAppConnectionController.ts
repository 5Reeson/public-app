import { useEffect, useState } from 'react'

import type { WhatsAppConnectionView, WhatsAppCredentialMode } from '../../../shared/domain.js'
import { toErrorMessage } from '../../../shared/errors.js'
import { isWhatsAppConnectionPending } from '../../../shared/whatsapp-connection.js'

interface UseWhatsAppConnectionControllerOptions {
  connection: WhatsAppConnectionView
  onConnectionChange(status: WhatsAppConnectionView): void
  onError(message: string): void
}

export interface WhatsAppConnectionController {
  busy: boolean
  pairingMode: boolean
  pairingPhone: string
  pairingPhoneIsValid: boolean
  setPairingPhone(value: string): void
  connectWithQr(): Promise<WhatsAppConnectionView | undefined>
  togglePhonePairing(): Promise<void>
  showPhonePairing(): Promise<void>
  requestPairingCode(): Promise<WhatsAppConnectionView | undefined>
  disconnect(): Promise<WhatsAppConnectionView | undefined>
  setCredentialMode(mode: WhatsAppCredentialMode): Promise<WhatsAppConnectionView | undefined>
  logout(): Promise<WhatsAppConnectionView | undefined>
}

export function useWhatsAppConnectionController({
  connection,
  onConnectionChange,
  onError,
}: UseWhatsAppConnectionControllerOptions): WhatsAppConnectionController {
  const [busy, setBusy] = useState(false)
  const [pairingMode, setPairingMode] = useState(false)
  const [pairingPhone, setPairingPhoneValue] = useState('')

  useEffect(() => {
    if (connection.phase === 'connected' || connection.phase === 'awaiting-qr') {
      setPairingMode(false)
    }
  }, [connection.phase])

  function setPairingPhone(value: string) {
    setPairingPhoneValue(value.replace(/[^\d+\s-]/g, ''))
  }

  async function run(
    operation: (api: NonNullable<typeof window.stickerApp>) => Promise<WhatsAppConnectionView>,
  ): Promise<WhatsAppConnectionView | undefined> {
    const api = window.stickerApp
    if (!api) {
      onError('桌面桥接不可用，请重新打开应用。')
      return undefined
    }
    setBusy(true)
    try {
      const status = await operation(api)
      onConnectionChange(status)
      return status
    } catch (reason) {
      onError(toErrorMessage(reason))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function connectWithQr() {
    setPairingMode(false)
    return run((api) => api.connectWhatsApp())
  }

  async function disconnect() {
    return run((api) => api.disconnectWhatsApp())
  }

  async function showPhonePairing() {
    if (isWhatsAppConnectionPending(connection.phase)) await disconnect()
    setPairingMode(true)
  }

  async function togglePhonePairing() {
    if (pairingMode) {
      setPairingMode(false)
      return
    }
    await showPhonePairing()
  }

  async function requestPairingCode() {
    return run((api) => api.connectWhatsApp(pairingPhone))
  }

  async function setCredentialMode(mode: WhatsAppCredentialMode) {
    if (mode === connection.credentialMode) return undefined
    return run((api) => api.setWhatsAppCredentialMode(mode))
  }

  async function logout() {
    if (
      !window.confirm(
        '确认登出 WhatsApp 并删除本机登录凭证？我的表情库、微信安全缓存和表情分组存档不会删除。',
      )
    ) {
      return undefined
    }
    return run((api) => api.logoutWhatsApp(true))
  }

  return {
    busy,
    pairingMode,
    pairingPhone,
    pairingPhoneIsValid: pairingPhone.replace(/\D/g, '').length >= 8,
    setPairingPhone,
    connectWithQr,
    togglePhonePairing,
    showPhonePairing,
    requestPairingCode,
    disconnect,
    setCredentialMode,
    logout,
  }
}
