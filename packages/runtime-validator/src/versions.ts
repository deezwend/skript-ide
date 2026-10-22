import type { AddonSelection } from './addons'

import { l } from '@skript-ide/i18n'
export interface RuntimeVersions {
  /** Paper / Minecraft sürümü, ör. `26.2`. */
  minecraft: string
  /** Skript sürümü; GitHub release etiketiyle aynı, ör. `2.16.2`. */
  skript: string
  /** Belirli bir Paper build'i. Verilmezse en son build kullanılır. */
  paperBuild?: number
  /** Sunucunun `plugins/` klasörüne kurulacak addon'lar (yalnızca indirme bilgisi olanlar kurulur). */
  addons?: readonly AddonSelection[]
}

export interface SkriptRuntimeProfile {
  /** Skript sürümü (GitHub release etiketi). */
  skript: string
  /** Doğrulama sunucusunda bu Skript sürümüyle çalıştırılan Paper / Minecraft sürümü. */
  minecraft: string
  /** Belirli bir Paper build'i; verilmezse en son build. */
  paperBuild?: number
  /** Bu Paper sürümü için gereken en düşük Java ana sürümü (PaperMC Fill API: `java.version.minimum`). */
  java: number
  /** Skript release notlarında desteklendiği yazan Minecraft aralığı. */
  supportedMinecraft: { min: string; max: string }
  /** Arayüzde gösterilecek kısa not. */
  note: string
}

/**
 * Seçilebilen Skript sürümleri ve her birinin doğrulama sunucusu için Paper/Java eşleşmesi, en yeniden eskiye.
 * Paper sürümü olarak her Skript sürümünün desteklediği en yeni Minecraft seçildi.
 *
 * Kaynaklar (2026-10-22'de kontrol edildi):
 * - Destek aralıkları: github.com/SkriptLang/Skript/releases (2.17.1 / 2.16.2 / 2.14.3 notlarındaki "Supports: Paper …"
 *   satırı; 2.12 için 2.12.0 notu "2.12 still supports 1.19.4+" ve 2.12.1 notu "support for Minecraft 1.21.8").
 * - Java: fill.papermc.io/v3/projects/paper/versions/<mc> → `java.version.minimum` (26.x → 25, 1.21.x → 21).
 * - Her çift bu makinede gerçek sunucuda `sk gen-docs` ve `sk reload` ile denendi (bkz. README).
 */
export const SKRIPT_RUNTIMES: readonly SkriptRuntimeProfile[] = [
  {
    skript: '2.17.1',
    minecraft: '26.3',
    java: 25,
    supportedMinecraft: { min: '1.21.5', max: '26.3' },
    get note() {
      return l('Güncel sürüm; Brigadier tabanlı yeni komut sistemi', 'Latest release; new Brigadier-based command system')
    }
  },
  {
    skript: '2.16.2',
    minecraft: '26.2',
    java: 25,
    supportedMinecraft: { min: '1.21.4', max: '26.2' },
    get note() {
      return l('2.16 serisinin son sürümü', 'Last release of the 2.16 series')
    }
  },
  {
    skript: '2.14.3',
    minecraft: '1.21.11',
    java: 21,
    supportedMinecraft: { min: '1.21.0', max: '1.21.11' },
    get note() {
      return l("2.15'teki MiniMessage/Adventure metin geçişinden önceki son sürüm", 'Last release before the MiniMessage/Adventure text migration in 2.15')
    }
  },
  {
    skript: '2.12.2',
    minecraft: '1.21.8',
    java: 21,
    supportedMinecraft: { min: '1.19.4', max: '1.21.8' },
    get note() {
      return l("Spigot desteği olan ve 1.19.4'ü destekleyen son seri", 'Last series with Spigot and 1.19.4 support')
    }
  }
]

export const DEFAULT_SKRIPT_VERSION = '2.17.1'

export function findRuntimeProfile(skriptVersion: string): SkriptRuntimeProfile | undefined {
  return SKRIPT_RUNTIMES.find((profile) => profile.skript === skriptVersion)
}

/** Bilinmeyen bir sürüm istenirse hata fırlatır. */
export function runtimeVersionsFor(skriptVersion: string): RuntimeVersions {
  const profile = findRuntimeProfile(skriptVersion)
  if (!profile) {
    throw new Error(
      l(`Skript ${skriptVersion} desteklenmiyor. Seçilebilen sürümler: ${SKRIPT_RUNTIMES.map((p) => p.skript).join(', ')}.`, `Skript ${skriptVersion} is not supported. Available versions: ${SKRIPT_RUNTIMES.map((p) => p.skript).join(', ')}.`)
    )
  }
  return { minecraft: profile.minecraft, skript: profile.skript, paperBuild: profile.paperBuild }
}

/** Proje ayarı yoksa kullanılan çift. */
export const DEFAULT_VERSIONS: RuntimeVersions = runtimeVersionsFor(DEFAULT_SKRIPT_VERSION)
