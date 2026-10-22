import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      // Workspace paketi TypeScript kaynağı olarak duruyor; dışarıda bırakılırsa çalışma anında yüklenemez
      externalizeDeps: { exclude: ['@skript-ide/runtime-validator', '@skript-ide/i18n'] }
    }
  },
  preload: {},
  renderer: {
    server: {
      port: 5199,
      strictPort: true
    },
    build: {
      // Monaco büyük bir paket; uyarı eşiğini buna göre ayarla
      chunkSizeWarningLimit: 8000
    },
    // Dil sunucusu worker'ı sürüm başına syntax veritabanını ayrı parça olarak dinamik import eder;
    // iife biçiminde code-splitting olmadığı için ES modülü gerekiyor.
    worker: {
      format: 'es'
    }
  }
})
