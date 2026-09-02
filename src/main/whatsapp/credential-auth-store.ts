import type { WhatsAppCredentialMode } from '../../shared/domain.js'
import type { LoadedWhatsAppAuthState, WhatsAppAuthStore } from './auth-store.js'
import { CredentialModeStore } from './credential-mode-store.js'

export class CredentialAuthStore implements WhatsAppAuthStore {
  private mode: WhatsAppCredentialMode = 'keychain'
  private initialized = false

  constructor(
    private readonly modeStore: CredentialModeStore,
    private readonly keychainStore: WhatsAppAuthStore,
    private readonly plaintextStore: WhatsAppAuthStore,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.mode = await this.modeStore.load()
    this.initialized = true
  }

  getMode(): WhatsAppCredentialMode {
    return this.mode
  }

  async setMode(mode: WhatsAppCredentialMode): Promise<void> {
    await this.initialize()
    if (mode === this.mode) return
    if ((await this.keychainStore.hasSession()) || (await this.plaintextStore.hasSession())) {
      throw new Error('已有 WhatsApp 登录凭证，请先登出后再切换凭证存储方式')
    }
    await this.modeStore.save(mode)
    this.mode = mode
  }

  async hasSession(): Promise<boolean> {
    await this.initialize()
    return this.activeStore().hasSession()
  }

  async load(): Promise<LoadedWhatsAppAuthState> {
    await this.initialize()
    return this.activeStore().load()
  }

  async clear(): Promise<void> {
    await this.initialize()
    await Promise.all([this.keychainStore.clear(), this.plaintextStore.clear()])
  }

  private activeStore(): WhatsAppAuthStore {
    return this.mode === 'keychain' ? this.keychainStore : this.plaintextStore
  }
}
