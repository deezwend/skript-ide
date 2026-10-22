import type { LineInfo } from './types.js'

/** Ayrıştırma sırasında LineInfo'ya ek olarak gereken ham satır bilgisi. */
export interface ParsedLine extends LineInfo {
  /** BOM çıkarılmış ham satır (satır sonu hariç). */
  raw: string
  /** BOM nedeniyle 0. satırdaki karakter kayması (0 veya 1). */
  charBase: number
  /** `#-#` ile devre dışı bırakılmış bölüm başlığı (Skript SectionNode kuralı). */
  disabledSection: boolean
}

export interface SplitDocument {
  lines: ParsedLine[]
  /** Kapatılmamış blok yorumunun açıldığı satır (0 tabanlı). */
  unclosedBlockCommentLine?: number
}

const enum SplitState {
  Code = 0,
  String = 1,
  Variable = 2,
  Halt = 3
}

function updateSplitState(character: string, state: SplitState, previousState: SplitState): SplitState {
  switch (character) {
    case '%':
      return state === SplitState.Code ? previousState : SplitState.Code
    case '"':
      if (state === SplitState.Code) return SplitState.String
      if (state === SplitState.String) return SplitState.Code
      return state
    case '{':
      return state === SplitState.String ? SplitState.String : SplitState.Variable
    case '}':
      return state === SplitState.String ? SplitState.String : SplitState.Code
    case '#':
      return state === SplitState.String ? SplitState.String : SplitState.Halt
    default:
      return state
  }
}

interface CommentScan {
  /** Ham satırda değerin bittiği (yorumun başladığı) indeks. */
  valueEnd: number
  /** Yorumun ham satırdaki başlangıcı. */
  commentStart?: number
}

/**
 * Skript'in Node.splitLine durum makinesinin konum üreten sürümü.
 * `##` kaçışı dışında metni değiştirmez; böylece editör konumları ham satırla hizalı kalır.
 */
function scanComment(raw: string): CommentScan {
  let state = SplitState.Code
  let previousState = SplitState.Code
  for (let i = 0; i < raw.length; i++) {
    const character = raw.charAt(i)
    if (character !== '%' && character !== '"' && character !== '#') {
      continue
    }
    // Çiftlenmiş kaçış karakterleri (string içindeki ## hariç) yorum başlatmaz.
    if (
      (character !== '#' || state !== SplitState.String) &&
      i + 1 < raw.length &&
      raw.charAt(i + 1) === character
    ) {
      i++
      continue
    }
    const oldState = state
    state = updateSplitState(character, state, previousState)
    if (state === SplitState.Halt) {
      return { valueEnd: i, commentStart: i }
    }
    if (character === '%' && state === SplitState.Code) {
      previousState = oldState
    }
  }
  return { valueEnd: raw.length }
}

const DISABLED_SECTION = /^([^#]|##)*#-#(\s.*)?$/

function makeLine(
  line: number,
  raw: string,
  charBase: number,
  valueEnd: number,
  commentStart: number | undefined,
  commentStartsAtZero: boolean
): ParsedLine {
  const indentMatch = /^[ \t]*/.exec(raw)
  const indent = indentMatch === null ? '' : indentMatch[0]
  const valuePart = raw.slice(0, valueEnd)
  const text = valuePart.slice(Math.min(indent.length, valuePart.length)).trimEnd()
  const start = charBase + indent.length
  const info: ParsedLine = {
    line,
    raw,
    charBase,
    indent,
    text,
    start,
    blank: text.length === 0,
    disabledSection: text.endsWith(':') && DISABLED_SECTION.test(raw)
  }
  if (commentStart !== undefined) {
    info.commentStart = charBase + (commentStartsAtZero ? 0 : commentStart)
  }
  return info
}

function makeCommentLine(line: number, raw: string, charBase: number, commentAt: number): ParsedLine {
  return makeLine(line, raw, charBase, 0, commentAt, false)
}

/**
 * Belgeyi satırlara ayırır. CRLF, LF ve tek CR satır sonu olarak kabul edilir.
 * Yalnızca dosyanın başındaki UTF-8 BOM çıkarılır; konumlar için charBase ile telafi edilir.
 */
export function splitDocument(text: string): SplitDocument {
  const rawLines = text.split(/\r\n|\n|\r/)

  // ConfigReader, BOM'u dosyanın ilk boş olmayan satırından çıkarır.
  let bomLine = -1
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index] ?? ''
    if (line.length === 0) continue
    if (line.startsWith('\uFEFF')) {
      rawLines[index] = line.slice(1)
      bomLine = index
    }
    break
  }

  const lines: ParsedLine[] = []
  let inBlockComment = false
  let blockCommentStartLine = -1

  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index] ?? ''
    const charBase = index === bomLine ? 1 : 0
    const trimmed = raw.trim()

    if (trimmed === '###') {
      if (!inBlockComment) {
        inBlockComment = true
        blockCommentStartLine = index
      } else {
        inBlockComment = false
      }
      const hash = raw.indexOf('#')
      lines.push(makeCommentLine(index, raw, charBase, hash < 0 ? 0 : hash))
      continue
    }

    if (trimmed.startsWith('#')) {
      const hash = raw.indexOf('#')
      lines.push(makeCommentLine(index, raw, charBase, hash < 0 ? 0 : hash))
      continue
    }

    if (inBlockComment) {
      // Blok yorumun içindeki her şey yorumdur; satırın tamamı yorum sayılır.
      lines.push(makeCommentLine(index, raw, charBase, 0))
      continue
    }

    const scan = scanComment(raw)
    lines.push(
      makeLine(
        index,
        raw,
        charBase,
        scan.valueEnd,
        scan.commentStart,
        false
      )
    )
  }

  const result: SplitDocument = { lines }
  if (inBlockComment) {
    result.unclosedBlockCommentLine = blockCommentStartLine
  }
  return result
}
