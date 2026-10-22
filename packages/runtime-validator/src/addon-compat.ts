// Bu dosya `npm run verify-addons -w @skript-ide/runtime-validator` tarafından üretilir; elle düzenleme.

import type { LocalizedText } from '@skript-ide/i18n'

export interface AddonCompatibility {
  addon: string
  addonVersion: string
  skript: string
  minecraft: string
  /** `partial`: eklenti açıldı ve deneme betiği yüklendi ama bazı öğe grupları devre dışı kaldı. */
  status: 'ok' | 'partial' | 'failed'
  /** Kısa açıklama: başarılıysa denenen betik, değilse sunucunun verdiği hata. */
  detail: LocalizedText
}

export const ADDON_COMPATIBILITY: readonly AddonCompatibility[] = [
  { addon: "SkBee", addonVersion: "3.26.0", skript: "2.17.1", minecraft: "26.3", status: "ok", detail: { tr: "Eklenti açıldı; NBT bileşeni oluşturup etiketlerini okuyan betik hatasız yüklendi.", en: "Addon enabled; a script that creates an NBT compound and reads its tags loaded without errors." } },
  { addon: "SkBee", addonVersion: "3.26.0", skript: "2.16.2", minecraft: "26.2", status: "ok", detail: { tr: "Eklenti açıldı; NBT bileşeni oluşturup etiketlerini okuyan betik hatasız yüklendi.", en: "Addon enabled; a script that creates an NBT compound and reads its tags loaded without errors." } },
  { addon: "SkBee", addonVersion: "3.26.0", skript: "2.14.3", minecraft: "1.21.11", status: "failed", detail: { tr: "Eklenti açıldı ama deneme betiği yüklenmedi: Can't understand this expression: 'a new nbt compound'", en: "Addon enabled but the test script did not load: Can't understand this expression: 'a new nbt compound'" } },
  { addon: "SkBee", addonVersion: "3.26.0", skript: "2.12.2", minecraft: "1.21.8", status: "failed", detail: { tr: "Eklenti açıldı ama deneme betiği yüklenmedi: Can't understand this expression: 'a new nbt compound'", en: "Addon enabled but the test script did not load: Can't understand this expression: 'a new nbt compound'" } },
  { addon: "SkBee", addonVersion: "3.16.1", skript: "2.17.1", minecraft: "26.3", status: "partial", detail: { tr: "Eklenti açıldı ama yüklenirken sorun bildirdi: Skript yüklenirken bu addon'la ilgili bir hata bildirdi (Severe Error). / Other Elements failed to load due to 'Can't register net.kyori.adventure.audience.Audience with the code name audience because that name is already used by audience' / NBT Elements DISABLED! / - Your server version [26.3] is not currently supported by the NBT-API", en: "Addon enabled but reported problems while loading: Skript reported an error related to this addon while loading (Severe Error). / Other Elements failed to load due to 'Can't register net.kyori.adventure.audience.Audience with the code name audience because that name is already used by audience' / NBT Elements DISABLED! / - Your server version [26.3] is not currently supported by the NBT-API" } },
  { addon: "SkBee", addonVersion: "3.16.1", skript: "2.16.2", minecraft: "26.2", status: "partial", detail: { tr: "Eklenti açıldı ama yüklenirken sorun bildirdi: Other Elements failed to load due to 'Can't register net.kyori.adventure.audience.Audience with the code name audience because that name is already used by audience' / NBT Elements DISABLED! / - Your server version [26.2] is not currently supported by the NBT-API", en: "Addon enabled but reported problems while loading: Other Elements failed to load due to 'Can't register net.kyori.adventure.audience.Audience with the code name audience because that name is already used by audience' / NBT Elements DISABLED! / - Your server version [26.2] is not currently supported by the NBT-API" } },
  { addon: "SkBee", addonVersion: "3.16.1", skript: "2.14.3", minecraft: "1.21.11", status: "ok", detail: { tr: "Eklenti açıldı; NBT bileşeni oluşturup etiketlerini okuyan betik hatasız yüklendi.", en: "Addon enabled; a script that creates an NBT compound and reads its tags loaded without errors." } },
  { addon: "SkBee", addonVersion: "3.16.1", skript: "2.12.2", minecraft: "1.21.8", status: "ok", detail: { tr: "Eklenti açıldı; NBT bileşeni oluşturup etiketlerini okuyan betik hatasız yüklendi.", en: "Addon enabled; a script that creates an NBT compound and reads its tags loaded without errors." } },
  { addon: "skript-reflect", addonVersion: "2.6.3", skript: "2.17.1", minecraft: "26.3", status: "ok", detail: { tr: "Eklenti açıldı; `import:` ile Java sınıfı çağıran betik hatasız yüklendi.", en: "Addon enabled; a script that calls a Java class via `import:` loaded without errors." } },
  { addon: "skript-reflect", addonVersion: "2.6.3", skript: "2.16.2", minecraft: "26.2", status: "ok", detail: { tr: "Eklenti açıldı; `import:` ile Java sınıfı çağıran betik hatasız yüklendi.", en: "Addon enabled; a script that calls a Java class via `import:` loaded without errors." } },
  { addon: "skript-reflect", addonVersion: "2.6.3", skript: "2.14.3", minecraft: "1.21.11", status: "ok", detail: { tr: "Eklenti açıldı; `import:` ile Java sınıfı çağıran betik hatasız yüklendi.", en: "Addon enabled; a script that calls a Java class via `import:` loaded without errors." } },
  { addon: "skript-reflect", addonVersion: "2.6.3", skript: "2.12.2", minecraft: "1.21.8", status: "failed", detail: { tr: "skript-reflect kendini devre dışı bıraktı. Ayrıntılar sunucu konsolunda.", en: "skript-reflect disabled itself. See the server console for details." } },
  { addon: "skript-reflect", addonVersion: "2.6.1", skript: "2.17.1", minecraft: "26.3", status: "failed", detail: { tr: "Error occurred while enabling skript-reflect v2.6.1 (Is it up to date?)", en: "Error occurred while enabling skript-reflect v2.6.1 (Is it up to date?)" } },
  { addon: "skript-reflect", addonVersion: "2.6.1", skript: "2.16.2", minecraft: "26.2", status: "failed", detail: { tr: "Error occurred while enabling skript-reflect v2.6.1 (Is it up to date?)", en: "Error occurred while enabling skript-reflect v2.6.1 (Is it up to date?)" } },
  { addon: "skript-reflect", addonVersion: "2.6.1", skript: "2.14.3", minecraft: "1.21.11", status: "failed", detail: { tr: "Error occurred while enabling skript-reflect v2.6.1 (Is it up to date?)", en: "Error occurred while enabling skript-reflect v2.6.1 (Is it up to date?)" } },
  { addon: "skript-reflect", addonVersion: "2.6.1", skript: "2.12.2", minecraft: "1.21.8", status: "ok", detail: { tr: "Eklenti açıldı; `import:` ile Java sınıfı çağıran betik hatasız yüklendi.", en: "Addon enabled; a script that calls a Java class via `import:` loaded without errors." } }
]
