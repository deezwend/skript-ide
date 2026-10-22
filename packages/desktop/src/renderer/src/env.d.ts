/// <reference types="vite/client" />

import type { SkriptIdeApi } from '../../shared/ipc'

declare global {
  interface Window {
    /** Preload tarafından sağlanır; düz tarayıcıda (önizleme) tanımsızdır. */
    skriptIde?: SkriptIdeApi
  }
}
