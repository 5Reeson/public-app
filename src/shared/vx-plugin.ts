export const VX_PLUGIN_SCHEMA_VERSION = 1
export const VX_PLUGIN_API_VERSION = 1
export const VX_PLUGIN_DISTRIBUTION_SCHEMA_VERSION = 1

export type VxPluginCapability =
  | {
      state: 'ready'
      pluginVersion: string
      pluginApiVersion: number
      architecture: string
    }
  | {
      state: 'missing'
      installPageUrl?: string
    }
  | {
      state: 'incompatible'
      reason: string
      installPageUrl?: string
    }

export interface VxPluginDistributionAvailability {
  remoteInstall: boolean
}

export type VxPluginInstallPhase =
  'checking' | 'downloading' | 'verifying' | 'installing' | 'complete'

export interface VxPluginInstallProgress {
  phase: VxPluginInstallPhase
  message: string
  completedBytes?: number
  totalBytes?: number
}

export interface VxPluginInstallResult {
  canceled: boolean
  capability: VxPluginCapability
}
