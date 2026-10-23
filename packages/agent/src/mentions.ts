/**
 * Kullanıcı mesajındaki `@dosya` etiketleri. Saf modül (Node API'si yok); arayüz de doğrudan kullanır.
 * Etiketlenen dosyanın içeriği mesaja ayrı bir metin bloğu olarak eklenir; böylece model dosyayı
 * okumak için ayrıca tool çağırmaz, arayüz de bu blokları baloncukta göstermeyip etiket olarak çizer.
 */

const ATTACHMENT = /^<attached_file path="([^"]*)">\n([\s\S]*)\n<\/attached_file>$/
const PROBLEMS_ATTACHMENT = /^<attached_problems>\n([\s\S]*)\n<\/attached_problems>$/
const CONVERSATION_ATTACHMENT = /^<attached_conversation id="([^"]*)" title="([^"]*)">\n([\s\S]*)\n<\/attached_conversation>$/

/** Dosya yerine geçmiş bir konuşmayı etiketleyen önek: `@chat:3f2a9c1d` (kimliğin ilk karakterleri). */
export const CONVERSATION_MENTION_PREFIX = 'chat:'
/** Etikette yazılan kimlik uzunluğu. */
export const CONVERSATION_REF_LENGTH = 8

/** Dosya yerine PROBLEMLER sekmesini etiketleyen adlar (`@Problems`, `@Problemler`; büyük/küçük harf fark etmez). */
export const PROBLEMS_MENTIONS = ['Problems', 'Problemler']
/** Modele gönderilen en fazla sorun; fazlası özet satırıyla belirtilir. */
const MAX_PROBLEMS = 500

/** PROBLEMLER sekmesindeki bir satır; `path` proje köküne göre (ya da adsız belgenin başlığı). */
export interface ProblemReport {
  path: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  /** `static`: dil sunucusunun analizi, `server`: Paper + Skript doğrulaması. */
  origin: 'static' | 'server'
  message: string
  code?: string
}

/** Etiketten sonra yazılmış, yolun parçası olmayan noktalama (`@a.sk,` → `a.sk`). */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/

/**
 * Metindeki `@yol` ve `@"boşluklu yol"` etiketlerini sırayla, tekrarsız döndürür.
 * `@` bir kelimenin başında olmalı; e-posta gibi `ad@alan` biçimleri etiket sayılmaz.
 */
export function parseMentions(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|(\S+))/g)) {
    const path = match[1] ?? match[2].replace(TRAILING_PUNCTUATION, '')
    if (path && !found.includes(path)) found.push(path)
  }
  return found
}

/** Etiket bir dosya değil, PROBLEMLER sekmesi mi? */
export function isProblemsMention(mention: string): boolean {
  const name = mention.toLowerCase()
  return PROBLEMS_MENTIONS.some((alias) => alias.toLowerCase() === name)
}

/** Etiket geçmiş bir konuşmayı gösteriyorsa kimlik önekini, değilse `null` döndürür. */
export function conversationMentionRef(mention: string): string | null {
  if (!mention.toLowerCase().startsWith(CONVERSATION_MENTION_PREFIX)) return null
  const ref = mention.slice(CONVERSATION_MENTION_PREFIX.length).toLowerCase()
  return /^[0-9a-f-]{4,36}$/.test(ref) ? ref : null
}

/** Konuşmanın girişe yazılacak etiketi. */
export function conversationMention(id: string): string {
  return `@${CONVERSATION_MENTION_PREFIX}${id.slice(0, CONVERSATION_REF_LENGTH)}`
}

/** Yolu girişe yazılacak etiket biçimine çevirir; boşluk varsa tırnaklanır. */
export function formatMention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

/** Etiketlenen dosyanın modele giden metni. */
export function attachmentText(path: string, content: string): string {
  return `<attached_file path="${path.replace(/"/g, '')}">\n${content}\n</attached_file>`
}

/** `@Problems` etiketinin modele giden metni: her satırda bir sorun. */
export function problemsAttachmentText(problems: ProblemReport[]): string {
  const lines = problems.slice(0, MAX_PROBLEMS).map((p) => {
    const location = p.column > 0 ? `${p.path}:${p.line}:${p.column}` : `${p.path}:${p.line}`
    return `${location} ${p.severity} [${p.origin}] ${p.message}${p.code ? ` (${p.code})` : ''}`
  })
  if (problems.length > MAX_PROBLEMS) lines.push(`… ${problems.length - MAX_PROBLEMS} more problems not shown`)
  if (lines.length === 0) lines.push('No problems reported.')
  return `<attached_problems>\n${lines.join('\n')}\n</attached_problems>`
}

/** Etiketlenen geçmiş konuşmanın modele giden metni; `content` konuşmanın dökümü. */
export function conversationAttachmentText(id: string, title: string, content: string): string {
  return `<attached_conversation id="${id}" title="${title.replace(/["\n]/g, '')}">\n${content}\n</attached_conversation>`
}

/**
 * Metin bloğu bir dosya eki, sorun listesi ya da konuşma eki ise yolunu ve içeriğini döndürür.
 * Sorun listesinin yolu `Problems`; konuşma ekinin yolu etiketi (`chat:…`), kimliği ve başlığı `conversation`'da.
 */
export function parseAttachment(text: string): { path: string; content: string; conversation?: { id: string; title: string } } | null {
  const match = ATTACHMENT.exec(text)
  if (match) return { path: match[1], content: match[2] }
  const problems = PROBLEMS_ATTACHMENT.exec(text)
  if (problems) return { path: PROBLEMS_MENTIONS[0], content: problems[1] }
  const conversation = CONVERSATION_ATTACHMENT.exec(text)
  if (!conversation) return null
  const [, id, title, content] = conversation
  return { path: conversationMention(id).slice(1), content, conversation: { id, title } }
}
