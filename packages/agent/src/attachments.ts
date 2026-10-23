import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TextBlock } from './messages'
import { attachmentText, conversationMentionRef, isProblemsMention, parseMentions } from './mentions'
import { displayPath, IGNORED_DIRS, isInside } from './tools/core/paths'

/** Etiket listesinde gösterilen en fazla dosya. */
const MAX_LISTED_FILES = 5000
/** Mesaja eklenen tek dosyanın en büyük boyutu; daha büyüğünü model `read_file` ile parça parça okur. */
const MAX_ATTACHMENT_BYTES = 256 * 1024

/** `@` etiket listesi için projedeki dosyalar (köke göre, `/` ile); atlanan klasörler aramadakiyle aynı. */
export async function listProjectFiles(projectRoot: string): Promise<string[]> {
  const root = await realpath(projectRoot)
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(full)
      } else if (entry.isFile()) {
        files.push(displayPath(root, full))
      }
    }
  }
  await walk(root)
  return files.sort((a, b) => a.localeCompare(b))
}

export interface MentionAttachments {
  blocks: TextBlock[]
  /** Bulunamayan, proje dışında kalan ya da çok büyük olan etiketler; mesajda olduğu gibi kalır. */
  skipped: string[]
}

/**
 * Metindeki `@dosya` etiketlerini okur ve her biri için ek bloğu üretir.
 * Yalnızca proje içindeki, var olan metin dosyaları eklenir; `@Problems` ve `@chat:…` dosya sayılmaz.
 */
export async function readMentions(projectRoot: string | null, text: string): Promise<MentionAttachments> {
  const mentions = parseMentions(text).filter((mention) => !isProblemsMention(mention) && conversationMentionRef(mention) === null)
  const result: MentionAttachments = { blocks: [], skipped: [] }
  if (mentions.length === 0) return result
  if (!projectRoot) return { blocks: [], skipped: mentions }
  const root = await realpath(projectRoot)
  for (const mention of mentions) {
    try {
      const file = await realpath(resolve(root, mention))
      const info = await stat(file)
      if (!isInside(root, file) || !info.isFile() || info.size > MAX_ATTACHMENT_BYTES) throw new Error()
      result.blocks.push({ type: 'text', text: attachmentText(displayPath(root, file), await readFile(file, 'utf8')) })
    } catch {
      result.skipped.push(mention)
    }
  }
  return result
}
