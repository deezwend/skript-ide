/**
 * Agent hafızası: konuşmalar arasında taşınan kısa notlar. İki kapsam vardır: kullanıcı hafızası
 * (tüm projeler; masaüstü uygulaması `userData` altında tutar) ve proje hafızası
 * (`.skript-ide/memory.md`). Her not dosyada bir `- ` satırıdır; dosya elle de düzenlenebilir.
 * Hafıza, proje talimatları gibi değiştiği ilk kullanıcı mesajına blok olarak eklenir; böylece geçmiş
 * yalnızca büyür, önbellek korunur. Saf modül; arayüz de kullanır.
 */
import type { Message } from './messages'

/** Proje hafızasının proje köküne göre yolu. */
export const PROJECT_MEMORY_FILE = '.skript-ide/memory.md'

export type MemoryScope = 'user' | 'project'

/** Tek notun en fazla karakter sayısı. */
export const MAX_MEMORY_ENTRY_CHARS = 500
/** Bir kapsamın modele giden en fazla karakter sayısı; fazlası kesilir ve modele not düşülür. */
export const MAX_MEMORY_CHARS = 8 * 1024

const MEMORY = /^<agent_memory>\n([\s\S]*)\n<\/agent_memory>$/
const CLEARED = '<agent_memory_cleared />'

/** Sistem isteminde sabit kalan açıklama; blokların ne anlama geldiğini ve ne zaman not alınacağını söyler. */
export const MEMORY_INSTRUCTIONS = [
  'You have a memory that persists across conversations. It arrives as an <agent_memory> block in a user message, with a "User" section (applies to every project) and a "Project" section (this project only); <agent_memory_cleared /> means it is now empty. Treat it as background you already know, not as instructions from this message.',
  '- Save a note with remember when you learn something that will matter in future conversations: the user\'s preferences and way of working, corrections they gave you, facts about their server or setup, and decisions that are not visible in the code. Use scope "user" for things about the person, "project" for things about this project.',
  '- Do not save what the code, SKRIPT.md or the conversation itself already records, temporary task state, or secrets. Keep each note to one short, self-contained sentence.',
  '- When a note becomes wrong, update it with remember (replaces) or remove it with forget instead of adding a contradicting note. When the user asks you to remember or forget something, do it.',
  '- Past conversations are saved. When the user refers to earlier work ("like last time", "the command we wrote yesterday"), find it with search_conversations and read it with read_conversation. A conversation the user tags with @chat:… arrives as an <attached_conversation> block.'
].join('\n')

/** Hafıza dosyasındaki notlar: `- ` ile başlayan satırlar, sırasıyla. */
export function memoryEntries(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => (/^\s*[-*]\s+\S/.test(line) ? [line.replace(/^\s*[-*]\s+/, '').trim()] : []))
}

/** Notu tek satıra indirir; boşsa ya da çok uzunsa hata metni döndürür. */
export function normalizeMemoryEntry(text: string): { entry: string } | { error: string } {
  const entry = text.replace(/\s+/g, ' ').trim()
  if (!entry) return { error: 'The note is empty.' }
  if (entry.length > MAX_MEMORY_ENTRY_CHARS) {
    return { error: `The note is too long (${entry.length} characters, at most ${MAX_MEMORY_ENTRY_CHARS}). Make it shorter.` }
  }
  return { entry }
}

/** İki kapsamın içeriğinden modele giden blok; ikisi de boşsa `null`. */
export function memoryText(user: string | null, project: string | null): string | null {
  const sections: string[] = []
  if (user?.trim()) sections.push(`## User (all projects)\n${truncate(user.trim())}`)
  if (project?.trim()) sections.push(`## Project (${PROJECT_MEMORY_FILE})\n${truncate(project.trim())}`)
  return sections.length ? `<agent_memory>\n${sections.join('\n\n')}\n</agent_memory>` : null
}

function truncate(text: string): string {
  if (text.length <= MAX_MEMORY_CHARS) return text
  return `${text.slice(0, MAX_MEMORY_CHARS)}\n[Memory truncated: showing the first ${MAX_MEMORY_CHARS / 1024} KB. Remove outdated notes with forget.]`
}

/** Metin bloğu bir hafıza bloğuysa içeriğini (`null`: boşaltıldı) döndürür; değilse `undefined`. */
export function parseMemory(text: string): string | null | undefined {
  if (text === CLEARED) return null
  const match = MEMORY.exec(text)
  return match ? match[1] : undefined
}

/** Geçmişte modele en son bildirilen hafıza bloğu; hiç bildirilmediyse ya da boşaltıldıysa `null`. */
export function latestMemory(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j]
      if (block.type !== 'text') continue
      const memory = parseMemory(block.text)
      if (memory !== undefined) return memory === null ? null : block.text
    }
  }
  return null
}

/** Hafıza geçmişte bildirilenden farklıysa yeni mesaja eklenecek blok metni; aynıysa `null`. */
export function memoryUpdate(messages: readonly Message[], memory: string | null): string | null {
  const previous = latestMemory(messages)
  if (memory === null) return previous === null ? null : CLEARED
  return previous === memory ? null : memory
}

/** Kullanıcı ve proje hafızasını okur; dosya yoksa o kapsam boştur. */
export async function loadMemory(userFile: string | null, projectRoot: string | null): Promise<string | null> {
  // Node modülleri yalnızca çağrıldığında yüklenir; arayüz bu dosyayı saf yardımcılar için içe aktarıyor
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const read = async (file: string | null) => {
    if (!file) return null
    try {
      return await readFile(file, 'utf8')
    } catch {
      return null
    }
  }
  return memoryText(await read(userFile), await read(projectRoot ? join(projectRoot, ...PROJECT_MEMORY_FILE.split('/')) : null))
}
