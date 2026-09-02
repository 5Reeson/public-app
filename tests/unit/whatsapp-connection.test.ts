import { describe, expect, it } from 'vitest'

import type { WhatsAppConnectionPhase } from '../../src/shared/domain.js'
import {
  isWhatsAppConnectionActive,
  isWhatsAppConnectionPending,
  whatsAppConnectionLabel,
} from '../../src/shared/whatsapp-connection.js'

describe('WhatsApp connection state helpers', () => {
  it('distinguishes pending connection phases from connected and terminal phases', () => {
    const pending: WhatsAppConnectionPhase[] = [
      'connecting',
      'reconnecting',
      'awaiting-qr',
      'awaiting-pairing-code',
    ]
    const terminal: WhatsAppConnectionPhase[] = ['disconnected', 'logged-out', 'error']

    for (const phase of pending) {
      expect(isWhatsAppConnectionPending(phase)).toBe(true)
      expect(isWhatsAppConnectionActive(phase)).toBe(true)
    }
    expect(isWhatsAppConnectionPending('connected')).toBe(false)
    expect(isWhatsAppConnectionActive('connected')).toBe(true)
    for (const phase of terminal) {
      expect(isWhatsAppConnectionPending(phase)).toBe(false)
      expect(isWhatsAppConnectionActive(phase)).toBe(false)
    }
  })

  it('provides the shared labels used by connection surfaces', () => {
    expect(whatsAppConnectionLabel('connected')).toBe('已连接')
    expect(whatsAppConnectionLabel('awaiting-qr')).toBe('等待关联')
    expect(whatsAppConnectionLabel('awaiting-pairing-code')).toBe('等待关联')
    expect(whatsAppConnectionLabel('error')).toBe('连接异常')
    expect(whatsAppConnectionLabel('logged-out')).toBe('未登录')
    expect(whatsAppConnectionLabel('disconnected')).toBe('未连接')
  })
})
