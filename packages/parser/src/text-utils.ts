const IDENT_START_UNICODE = /^[\p{L}_]$/u
const IDENT_PART_UNICODE = /^[\p{L}\p{N}_]$/u

export function isAsciiIdentStart(codePoint: number): boolean {
  return codePoint === 95 || (codePoint >= 65 && codePoint <= 90) || (codePoint >= 97 && codePoint <= 122)
}

export function isIdentStartCodePoint(codePoint: number): boolean {
  if (isAsciiIdentStart(codePoint)) return true
  if (codePoint <= 127) return false
  return IDENT_START_UNICODE.test(String.fromCodePoint(codePoint))
}

export function isIdentPartCodePoint(codePoint: number): boolean {
  if (isAsciiIdentStart(codePoint) || (codePoint >= 48 && codePoint <= 57)) return true
  if (codePoint <= 127) return false
  return IDENT_PART_UNICODE.test(String.fromCodePoint(codePoint))
}

export function codePointLengthAt(text: string, index: number): number {
  const codePoint = text.codePointAt(index)
  if (codePoint === undefined) return 1
  return codePoint > 0xffff ? 2 : 1
}

export function previousCodePoint(text: string, index: number): number {
  if (index <= 0) return -1
  const last = text.charCodeAt(index - 1)
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const codePoint = text.codePointAt(index - 2)
    if (codePoint !== undefined) return codePoint
  }
  return last
}

export function isIdentStartAt(text: string, index: number): boolean {
  const codePoint = text.codePointAt(index)
  return codePoint !== undefined && isIdentStartCodePoint(codePoint)
}

export function isIdentPartAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false
  const codePoint = text.codePointAt(index)
  return codePoint !== undefined && isIdentPartCodePoint(codePoint)
}

/** Açılış `{` konumundan eşleşen `}` konumunu bulur; yoksa -1. Skript gibi yalnızca süslü parantez sayar. */
export function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const character = text.charAt(i)
    if (character === '{') {
      depth++
    } else if (character === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Açılış `(` konumundan eşleşen `)` konumunu bulur; stringleri atlar. */
export function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const character = text.charAt(i)
    if (character === '"') {
      i = skipString(text, i) - 1
      continue
    }
    if (character === '(') {
      depth++
    } else if (character === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** `startIndex`teki açılış tırnağından sonra kapanış tırnağının bir sonraki konumu; yoksa metin sonu. */
export function skipString(text: string, startIndex: number): number {
  let i = startIndex + 1
  while (i < text.length) {
    if (text.charAt(i) === '"') {
      if (i + 1 < text.length && text.charAt(i + 1) === '"') {
        i += 2
        continue
      }
      return i + 1
    }
    if (text.charAt(i) === '%') {
      if (i + 1 < text.length && text.charAt(i + 1) === '%') {
        i += 2
        continue
      }
      const end = findInterpolationEnd(text, i)
      if (end < 0) return text.length
      i = end + 1
      continue
    }
    i++
  }
  return text.length
}

/**
 * `%` ile başlayan ifadenin kapanış `%` konumu. Skript VariableString gibi
 * ifade içindeki süslü parantezli değişkenleri atlar.
 */
export function findInterpolationEnd(text: string, startIndex: number): number {
  for (let i = startIndex + 1; i < text.length; i++) {
    const character = text.charAt(i)
    if (character === '{') {
      const end = findMatchingBrace(text, i)
      if (end < 0) return -1
      i = end
      continue
    }
    if (character === '%') return i
  }
  return -1
}

/** Verilen aralıkta kapanmamış ilk `{` konumu; yoksa -1. */
export function findUnclosedBrace(text: string, from: number, to = text.length): number {
  for (let i = from; i < to && i < text.length; i++) {
    if (text.charAt(i) !== '{') continue
    const end = findMatchingBrace(text, i)
    if (end < 0) return i
    i = end
  }
  return -1
}

/** String, parantez, köşeli parantez ve süslü parantez içindeki ayırıcıları atlar. */
export function findTopLevelCharacter(
  text: string,
  needle: string,
  from = 0,
  to = text.length
): number {
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let i = from; i < to && i < text.length; i++) {
    const character = text.charAt(i)
    if (character === '"') {
      i = skipString(text, i) - 1
      continue
    }
    if (character === '(') {
      parens++
      continue
    }
    if (character === ')') {
      if (parens > 0) parens--
      continue
    }
    if (character === '[') {
      brackets++
      continue
    }
    if (character === ']') {
      if (brackets > 0) brackets--
      continue
    }
    if (character === '{') {
      braces++
      continue
    }
    if (character === '}') {
      if (braces > 0) braces--
      continue
    }
    if (character === needle && parens === 0 && brackets === 0 && braces === 0) {
      return i
    }
  }
  return -1
}

export interface TextSlice {
  /** Ayırıcılar arasındaki ham parça. */
  text: string
  /** Ham parçanın metindeki başlangıcı. */
  start: number
  /** Ham parçanın metindeki bitişi (dahil değil). */
  end: number
  /** Baş/son boşlukları kırpılmış metnin başlangıcı. */
  trimmedStart: number
  /** Baş/son boşlukları kırpılmış metnin bitişi (dahil değil). */
  trimmedEnd: number
}

export function splitTopLevel(text: string, separator: string): TextSlice[] {
  const slices: TextSlice[] = []
  let sliceStart = 0
  const push = (end: number): void => {
    const raw = text.slice(sliceStart, end)
    const empty = raw.trim().length === 0
    const leading = raw.length - raw.trimStart().length
    const trailing = raw.length - raw.trimEnd().length
    slices.push({
      text: raw,
      start: sliceStart,
      end,
      trimmedStart: empty ? end : sliceStart + leading,
      trimmedEnd: empty ? end : end - trailing
    })
    sliceStart = end + separator.length
  }

  let parens = 0
  let brackets = 0
  let braces = 0
  for (let i = 0; i < text.length; i++) {
    const character = text.charAt(i)
    if (character === '"') {
      i = skipString(text, i) - 1
      continue
    }
    if (character === '(') parens++
    else if (character === ')') {
      if (parens > 0) parens--
    } else if (character === '[') brackets++
    else if (character === ']') {
      if (brackets > 0) brackets--
    } else if (character === '{') braces++
    else if (character === '}') {
      if (braces > 0) braces--
    } else if (
      character === separator &&
      parens === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      push(i)
    }
  }
  push(text.length)
  return slices
}
