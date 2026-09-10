import type { EncoreApi } from './index'

declare global {
  interface Window {
    encore: EncoreApi
  }
}

export {}
