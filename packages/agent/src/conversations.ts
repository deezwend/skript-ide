/**
 * Geçmiş konuşmaların modele giden düz metin dökümü, araması ve `@chat:…` eki. Kayıtlar masaüstü
 * uygulamasında tutulur; bu modül yalnızca `ConversationArchive` üzerinden okur. Saf modül.
 */
import { isConversationSummary } from './compaction'
import { isEditorContext } from './editor-context'
import { parseGoal } from './goal'
import { parseMemory } from './memory'
import { conversationAttachmentText, CONVERSATION_REF_LENGTH, parseAttachment } from './mentions'
import type { Message } from './messages'
import { parseProjectInstructions } from './project-memory'
import type { ConversationArchive, ConversationInfo } from './tool'

/** `@chat:…` ile eklenen konuşmanın en fazla karakter sayısı; fazlası `read_conversation` ile okunur. */
export const MAX_ATTACHED_CONVERSATION_CHARS = 40_000
/** `read_conversation`'ın bir seferde döndürdüğü karakter sayısı. */
export const CONVERSATION_PAGE_CHARS = 20_000
/** Dökümde tool çağrısı girdisinin en fazla uzunluğu. */
const MAX_TOOL_INPUT = 160

/**
 * Konuşmanın okunur dökümü: kullanıcı ve asistan metinleri, tool çağrıları tek satır. Tool sonuçları,
 * görseller, düşünme blokları ve modele giden bağlam blokları (hafıza, editör, talimatlar) yazılmaz.
 */
export function conversationTranscript(messages: readonly Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_call') {
        const input = JSON.stringify(block.input) ?? ''
        parts.push(`[tool ${block.name} ${input.length > MAX_TOOL_INPUT ? `${input.slice(0, MAX_TOOL_INPUT)}…` : input}]`)
      } else if (block.type === 'tool_result') {
        if (block.isError) parts.push(`[tool error: ${block.content.split('\n')[0].slice(0, MAX_TOOL_INPUT)}]`)
      } else if (block.type === 'image') {
        parts.push('[image]')
      } else if (block.type === 'text' && block.text.trim()) {
        const text = block.text
        if (message.role === 'assistant') {
          parts.push(`Assistant: ${text.trim()}`)
          continue
        }
        const attachment = parseAttachment(text)
        if (attachment) {
          parts.push(attachment.conversation ? `[attached conversation: ${attachment.conversation.title}]` : `[attached ${attachment.path}]`)
          continue
        }
        if (isConversationSummary(text)) {
          parts.push(`Summary of earlier messages: ${text.replace(/^<conversation_summary>\n|\n<\/conversation_summary>$/g, '').trim()}`)
          continue
        }
        const goal = parseGoal(text)
        if (goal !== undefined) {
          if (goal !== null) parts.push(`[goal: ${goal}]`)
          continue
        }
        if (parseMemory(text) !== undefined || parseProjectInstructions(text) !== undefined || isEditorContext(text)) continue
        parts.push(`User: ${text.trim()}`)
      }
    }
  }
  return parts.join('\n\n')
}

/** Konuşmanın tek satırlık kimliği: kısa kimlik, tarih, başlık, proje. */
export function conversationLabel(info: ConversationInfo): string {
  const project = info.projectRoot ? ` · project: ${info.projectRoot}` : ''
  return `${shortId(info.id)} · ${formatDate(info.updatedAt)} · "${info.title}" · ${info.turns} message(s)${project}`
}

export function shortId(id: string): string {
  return id.slice(0, CONVERSATION_REF_LENGTH)
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

/** Tam kimliği ya da benzersiz bir öneki konuşmaya çevirir; bulunamazsa ya da önek çakışırsa açıklayıcı hata atar. */
export async function resolveConversation(
  archive: ConversationArchive,
  ref: string
): Promise<{ info: ConversationInfo; messages: readonly Message[] }> {
  const wanted = ref.trim().toLowerCase().replace(/^@?chat:/, '')
  if (!/^[0-9a-f-]{4,36}$/.test(wanted)) throw new Error(`"${ref}" is not a conversation id.`)
  const matches = (await archive.list()).filter((info) => info.id.startsWith(wanted))
  if (matches.length === 0) throw new Error(`No saved conversation has the id ${ref}.`)
  if (matches.length > 1) throw new Error(`${ref} matches ${matches.length} conversations; use a longer id.`)
  const found = await archive.read(matches[0].id)
  if (!found) throw new Error(`Conversation ${ref} could not be read.`)
  return found
}

/** `@chat:…` etiketinin modele giden eki; uzun konuşma kesilir ve devamının nasıl okunacağı yazılır. */
export function attachedConversationText(info: ConversationInfo, messages: readonly Message[]): string {
  const transcript = conversationTranscript(messages)
  const body =
    transcript.length > MAX_ATTACHED_CONVERSATION_CHARS
      ? `${transcript.slice(0, MAX_ATTACHED_CONVERSATION_CHARS)}\n\n[Truncated: ${transcript.length - MAX_ATTACHED_CONVERSATION_CHARS} more characters. Read the rest with read_conversation id=${shortId(info.id)} offset=${MAX_ATTACHED_CONVERSATION_CHARS}.]`
      : transcript
  return conversationAttachmentText(shortId(info.id), info.title, `${conversationLabel(info)}\n\n${body}`)
}

/** Dökümün `offset`'ten başlayan bir sayfası; devamı varsa sonraki `offset` yazılır. */
export function conversationPage(info: ConversationInfo, messages: readonly Message[], offset = 0): string {
  const transcript = conversationTranscript(messages)
  const start = Math.max(0, Math.min(Math.floor(offset), transcript.length))
  const end = Math.min(transcript.length, start + CONVERSATION_PAGE_CHARS)
  const header = `${conversationLabel(info)}\nCharacters ${start}-${end} of ${transcript.length}.`
  const more = end < transcript.length ? `\n\n[Continue with read_conversation id=${shortId(info.id)} offset=${end}.]` : ''
  return `${header}\n\n${transcript.slice(start, end) || '(empty)'}${more}`
}

export interface ConversationMatch {
  info: ConversationInfo
  /** Terimlerin toplam geçiş sayısı. */
  hits: number
  snippets: string[]
}

const SNIPPET_RADIUS = 90
const MAX_SNIPPETS = 2

/**
 * Tüm terimleri (boşlukla ayrılmış, büyük/küçük harf duyarsız) başlıkta ya da dökümde geçen konuşmalar;
 * çok geçenler önde, eşitlikte yeni olan önde.
 */
export function searchConversations(
  entries: readonly { info: ConversationInfo; transcript: string }[],
  query: string
): ConversationMatch[] {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
  const matches: ConversationMatch[] = []
  for (const { info, transcript } of entries) {
    const haystack = `${info.title}\n${transcript}`.toLowerCase()
    let hits = 0
    for (const term of terms) {
      const count = haystack.split(term).length - 1
      if (count === 0) {
        hits = -1
        break
      }
      hits += count
    }
    if (hits < 0) continue
    matches.push({ info, hits, snippets: snippets(transcript, terms) })
  }
  return matches.sort((a, b) => b.hits - a.hits || b.info.updatedAt - a.info.updatedAt)
}

/** İlk terimin ilk geçtiği yerlerin çevresi; tek satıra indirilmiş. */
function snippets(transcript: string, terms: string[]): string[] {
  const lower = transcript.toLowerCase()
  const found: string[] = []
  let from = 0
  while (terms.length && found.length < MAX_SNIPPETS) {
    const index = lower.indexOf(terms[0], from)
    if (index < 0) break
    const start = Math.max(0, index - SNIPPET_RADIUS)
    const end = Math.min(transcript.length, index + terms[0].length + SNIPPET_RADIUS)
    found.push(`${start > 0 ? '…' : ''}${transcript.slice(start, end).replace(/\s+/g, ' ').trim()}${end < transcript.length ? '…' : ''}`)
    from = end
  }
  return found
}
