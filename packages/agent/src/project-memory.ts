/**
 * Proje hafızası: proje kökündeki talimat dosyası (SKRIPT.md) modele bağlam olarak verilir.
 * Sistem istemine yazılmaz; değiştiğinde bir sonraki kullanıcı mesajına blok olarak eklenir
 * (goal.ts deseniyle aynı: geçmiş yalnızca büyür, önbellek korunur). Saf modül; arayüz de kullanır.
 */
import type { Message } from './messages'

/** Sırayla aranan dosyalar; ilk bulunan kullanılır. */
export const PROJECT_MEMORY_FILES = ['SKRIPT.md', 'AGENTS.md', '.skript-ide/instructions.md'] as const

/** Dosyanın modele giden en fazla karakter sayısı; fazlası kesilir ve modele not düşülür. */
export const MAX_PROJECT_MEMORY_CHARS = 16 * 1024

const INSTRUCTIONS = /^<project_instructions path="([^"]*)">\n([\s\S]*)\n<\/project_instructions>$/
const CLEARED = '<project_instructions_cleared />'

export interface ProjectMemory {
  /** Proje köküne göre yol. */
  path: string
  text: string
}

/** Sistem isteminde sabit kalan açıklama; blokların ne anlama geldiğini modele söyler. */
export const PROJECT_MEMORY_INSTRUCTIONS =
  'The project may carry instructions in a SKRIPT.md file at the project root. They arrive as a ' +
  '<project_instructions path="…"> block in a user message, and <project_instructions_cleared /> means they were removed. ' +
  'Follow them as project conventions. When the user asks you to remember a project convention, add it to SKRIPT.md ' +
  'with write_file or edit_file.'

/**
 * Proje kökündeki talimat dosyasını okur: önce `SKRIPT.md`, yoksa `AGENTS.md`, yoksa
 * `.skript-ide/instructions.md`. Hiçbiri yoksa `null`. Büyük dosya kesilir ve not düşülür.
 */
export async function loadProjectMemory(root: string | null): Promise<ProjectMemory | null> {
  if (!root) return null
  // Node modülleri yalnızca çağrıldığında yüklenir; arayüz bu dosyayı saf yardımcılar için içe aktarıyor.
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  for (const path of PROJECT_MEMORY_FILES) {
    let text: string
    try {
      text = await readFile(join(root, ...path.split('/')), 'utf8')
    } catch {
      continue
    }
    if (text.length > MAX_PROJECT_MEMORY_CHARS) {
      text = `${text.slice(0, MAX_PROJECT_MEMORY_CHARS)}\n\n[Project instructions truncated: showing the first ${MAX_PROJECT_MEMORY_CHARS / 1024} KB of the file.]`
    }
    return { path, text }
  }
  return null
}

/** Talimatların modele giden metni. */
export function projectMemoryText(memory: ProjectMemory): string {
  return `<project_instructions path="${memory.path}">\n${memory.text}\n</project_instructions>`
}

/** Metin bloğu bir talimat bloğuysa içeriğini (`null`: kaldırıldı) döndürür; değilse `undefined`. */
export function parseProjectInstructions(text: string): ProjectMemory | null | undefined {
  if (text === CLEARED) return null
  const match = INSTRUCTIONS.exec(text)
  return match ? { path: match[1], text: match[2] } : undefined
}

/** Geçmişte modele en son bildirilen talimatlar; hiç bildirilmediyse ya da kaldırıldıysa `null`. */
export function latestProjectMemory(messages: readonly Message[]): ProjectMemory | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j]
      if (block.type !== 'text') continue
      const memory = parseProjectInstructions(block.text)
      if (memory !== undefined) return memory
    }
  }
  return null
}

/** Talimatlar geçmişte bildirilenle farklıysa yeni mesaja eklenecek blok metni; aynıysa `null`. */
export function projectMemoryUpdate(messages: readonly Message[], memory: ProjectMemory | null): string | null {
  const previous = latestProjectMemory(messages)
  if (memory === null) return previous === null ? null : CLEARED
  if (previous && previous.path === memory.path && previous.text === memory.text) return null
  return projectMemoryText(memory)
}
