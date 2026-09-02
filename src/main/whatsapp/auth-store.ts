import {
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys'

export interface StoredAuthState {
  creds: AuthenticationCreds
  keys: SignalDataSet
}

export interface LoadedWhatsAppAuthState {
  state: AuthenticationState
  saveCreds(): Promise<void>
}

export interface WhatsAppAuthStore {
  hasSession(): Promise<boolean>
  load(): Promise<LoadedWhatsAppAuthState>
  clear(): Promise<void>
}

export function hasPairedCredentials(creds: AuthenticationCreds): boolean {
  return Boolean(creds.registered || (creds.me?.id && creds.account))
}

export function createEmptyAuthState(): StoredAuthState {
  return { creds: initAuthCreds(), keys: {} }
}

export function createLoadedAuthState(
  stored: StoredAuthState,
  persist: () => Promise<void>,
): LoadedWhatsAppAuthState {
  return {
    state: {
      creds: stored.creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const values: Partial<Record<string, SignalDataTypeMap[T]>> = {}
          const category = stored.keys[type] as
            Record<string, SignalDataTypeMap[T] | null> | undefined
          for (const id of ids) {
            let value = category?.[id]
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as proto.Message.IAppStateSyncKeyData,
              ) as unknown as SignalDataTypeMap[T]
            }
            if (value) values[id] = value
          }
          return values as Record<string, SignalDataTypeMap[T]>
        },
        set: async (updates: SignalDataSet) => {
          for (const type of Object.keys(updates) as Array<keyof SignalDataTypeMap>) {
            const current = (stored.keys[type] ?? {}) as Record<string, unknown>
            const changes = updates[type] as Record<string, unknown | null>
            for (const [id, value] of Object.entries(changes)) {
              if (value === null) delete current[id]
              else current[id] = value
            }
            ;(stored.keys as Record<string, unknown>)[type] = current
          }
          await persist()
        },
      },
    },
    saveCreds: persist,
  }
}
