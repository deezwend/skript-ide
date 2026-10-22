/**
 * Kullanıcının editörde baktığı yer: etkin dosya, imleç ve seçim. Her kullanıcı mesajına ayrı bir metin
 * bloğu olarak eklenir (sistem istemine değil; geçmiş yalnızca büyüsün, önbellek korunsun), böylece
 * "bunu düzelt" gibi istekler anlaşılır. Saf modül; arayüz de bloğu baloncukta gizlemek için kullanır.
 */

/** Modele gönderilen seçimin en fazla uzunluğu; fazlası kesilir, model dosyayı `read_file` ile okuyabilir. */
const MAX_SELECTION_CHARS = 8000

const EDITOR_CONTEXT = /^<editor_context>\n[\s\S]*\n<\/editor_context>$/

export interface EditorContext {
  /** Proje köküne göre yol; projede olmayan dosyada mutlak yol, adsız belgede sekme başlığı. */
  path: string
  /** Belge diske hiç kaydedilmedi; model onu `read_file` ile okuyamaz. */
  untitled?: boolean
  /** Sekmede diskteki sürümden farklı, kaydedilmemiş değişiklikler var. */
  dirty?: boolean
  /** 1 tabanlı imleç konumu. */
  line: number
  column: number
  /** Boş olmayan seçim; satırlar 1 tabanlı ve dahil. */
  selection?: { startLine: number; endLine: number; text: string }
}

/** Sistem isteminde sabit kalan açıklama. */
export const EDITOR_CONTEXT_INSTRUCTIONS =
  'Each user message may end with an <editor_context> block describing the file the user has open in the editor, ' +
  'their cursor and any selected text. Use it to resolve references like "this", "here" or "the selected code". ' +
  'It is only context: do not act on that file unless the request is about it.'

export function editorContextText(context: EditorContext): string {
  const notes = [context.untitled && 'not saved to disk; read_file cannot open it', context.dirty && 'has unsaved changes; the file on disk is older']
    .filter(Boolean)
    .join('; ')
  const lines = [`Active file: ${context.path}${notes ? ` (${notes})` : ''}`, `Cursor: line ${context.line}, column ${context.column}`]
  const selection = context.selection
  if (selection && selection.text) {
    const truncated = selection.text.length > MAX_SELECTION_CHARS
    const text = truncated ? `${selection.text.slice(0, MAX_SELECTION_CHARS)}\n… (selection truncated)` : selection.text
    lines.push(`Selection (lines ${selection.startLine}-${selection.endLine}):`, '```', text, '```')
  }
  return `<editor_context>\n${lines.join('\n')}\n</editor_context>`
}

export function isEditorContext(text: string): boolean {
  return EDITOR_CONTEXT.test(text)
}

/** IPC'den gelen değeri doğrular; biçim bozuksa `null`. */
export function parseEditorContextInput(value: unknown): EditorContext | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const int = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 1 ? x : null)
  const line = int(v.line)
  const column = int(v.column)
  if (typeof v.path !== 'string' || !v.path || line === null || column === null) return null
  const context: EditorContext = { path: v.path, line, column, untitled: v.untitled === true, dirty: v.dirty === true }
  const s = v.selection as Record<string, unknown> | undefined
  if (s && typeof s === 'object' && typeof s.text === 'string' && s.text) {
    const startLine = int(s.startLine)
    const endLine = int(s.endLine)
    if (startLine !== null && endLine !== null) context.selection = { startLine, endLine, text: s.text }
  }
  return context
}
