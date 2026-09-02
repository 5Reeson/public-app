export const APP_UPDATE_CONFIG = {
  latestReleaseApiUrl: 'https://api.github.com/repos/5Reeson/tudu-stickers/releases/latest',
  releasePageUrl: 'https://github.com/5Reeson/tudu-stickers/releases/latest',
  startupDelayMs: 15_000,
  automaticCheckIntervalMs: 24 * 60 * 60_000,
  requestTimeoutMs: 8_000,
} as const
