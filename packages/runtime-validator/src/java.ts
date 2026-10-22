import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { l } from '@skript-ide/i18n'
export interface JavaInstallation {
  path: string
  major: number
  versionText: string
}

export class JavaNotFoundError extends Error {
  constructor(
    readonly requiredMajor: number,
    readonly found: JavaInstallation[]
  ) {
    const foundText = found.length
      ? l(`Bulunanlar: ${found.map((java) => `Java ${java.major} (${java.path})`).join(', ')}.`, `Found: ${found.map((java) => `Java ${java.major} (${java.path})`).join(', ')}.`)
      : l('Sistemde hiç Java bulunamadı.', 'No Java installation was found on this system.')
    super(
      l(
        `Sunucu için Java ${requiredMajor} veya üstü gerekiyor. ${foundText} ` +
          `https://adoptium.net adresinden Java ${requiredMajor} kurup uygulamayı yeniden başlatabilirsin.`,
        `The server needs Java ${requiredMajor} or newer. ${foundText} ` +
          `You can install Java ${requiredMajor} from https://adoptium.net and restart the app.`
      )
    )
    this.name = 'JavaNotFoundError'
  }
}

/** `java -version` çıktısından ana sürümü çıkarır: `"1.8.0_402"` → 8, `"25.0.4.1"` → 25. */
export function parseJavaMajor(output: string): number | null {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output)
  if (!match) return null
  const first = Number(match[1])
  return first === 1 && match[2] ? Number(match[2]) : first
}

function probe(path: string): Promise<JavaInstallation | null> {
  return new Promise((resolve) => {
    execFile(path, ['-version'], { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      // `java -version` çıktıyı stderr'e yazar
      const text = `${stderr}${stdout}`
      const major = error ? null : parseJavaMajor(text)
      resolve(major === null ? null : { path, major, versionText: text.split(/\r?\n/)[0].trim() })
    })
  })
}

/** Yaygın Windows kurulum klasörlerindeki `java.exe` dosyaları. */
function windowsCandidates(): string[] {
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
  const vendors = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']
  const found: string[] = []
  for (const root of roots) {
    for (const vendor of vendors) {
      const dir = join(root, vendor)
      if (!existsSync(dir)) continue
      for (const entry of readdirSync(dir)) {
        const exe = join(dir, entry, 'bin', 'java.exe')
        if (existsSync(exe)) found.push(exe)
      }
    }
  }
  return found
}

/**
 * Sırasıyla açıkça verilen yolu, JAVA_HOME'u, PATH'teki `java`'yı ve bilinen
 * kurulum klasörlerini dener; `minMajor` veya üstü olan ilk Java'yı döndürür.
 */
export async function findJava(minMajor: number, preferredPath?: string): Promise<JavaInstallation> {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java'
  const candidates = [
    preferredPath,
    process.env['JAVA_HOME'] && join(process.env['JAVA_HOME'], 'bin', exe),
    'java',
    ...(process.platform === 'win32' ? windowsCandidates() : [])
  ].filter((path): path is string => Boolean(path))

  const found: JavaInstallation[] = []
  for (const path of new Set(candidates)) {
    const java = await probe(path)
    if (!java) continue
    if (java.major >= minMajor) return java
    found.push(java)
  }
  throw new JavaNotFoundError(minMajor, found)
}
