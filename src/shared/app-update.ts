export interface AppUpdateInfo {
  currentVersion: string
  latestVersion: string
}

export interface AppUpdateState {
  currentVersion: string
  availableUpdate?: AppUpdateInfo
}

export type AppUpdateCheckResult =
  | { status: 'available'; update: AppUpdateInfo }
  | { status: 'up-to-date'; currentVersion: string }
  | { status: 'unavailable'; currentVersion: string }
