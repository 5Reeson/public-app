import type { StickerAppApi } from '../../shared/ipc.js'

declare global {
  interface Window {
    stickerApp?: StickerAppApi
  }
}

export {}
