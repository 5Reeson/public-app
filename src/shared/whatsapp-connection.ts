import type { WhatsAppConnectionPhase, WhatsAppConnectionView } from './domain.js'

export const INITIAL_WHATSAPP_CONNECTION: WhatsAppConnectionView = {
  phase: 'disconnected',
  hasSession: false,
  credentialMode: 'keychain',
  canChangeCredentialMode: true,
}

export function isWhatsAppConnectionPending(phase: WhatsAppConnectionPhase): boolean {
  return (
    phase === 'connecting' ||
    phase === 'reconnecting' ||
    phase === 'awaiting-qr' ||
    phase === 'awaiting-pairing-code'
  )
}

export function isWhatsAppConnectionActive(phase: WhatsAppConnectionPhase): boolean {
  return phase === 'connected' || isWhatsAppConnectionPending(phase)
}

export function whatsAppConnectionLabel(phase: WhatsAppConnectionPhase): string {
  if (phase === 'connected') return '已连接'
  if (phase === 'connecting' || phase === 'reconnecting') return '连接中'
  if (phase === 'awaiting-qr' || phase === 'awaiting-pairing-code') return '等待关联'
  if (phase === 'error') return '连接异常'
  if (phase === 'logged-out') return '未登录'
  return '未连接'
}
