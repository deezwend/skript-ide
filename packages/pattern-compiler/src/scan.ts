/**
 * Skript ifade metninde string, değişken ve parantez sınırlarını bulan yardımcılar.
 * `SkriptParser#next` ve `VariableString#nextVariableBracket` davranışını örnek alır.
 */

export function findStringEnd(text: string, quoteIndex: number): number {
  let inExpression = false
  for (let index = quoteIndex + 1; index < text.length; index++) {
    const char = text[index]
    if (char === '"' && !inExpression) {
      if (text[index + 1] === '"') {
        index++
        continue
      }
      return index
    }
    if (char === '%') inExpression = !inExpression
  }
  return -1
}

export function findPercentEnd(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    if (text[index] === '\\') {
      index++
    } else if (text[index] === '%') {
      return index
    }
  }
  return -1
}

export function findBraceEnd(text: string, openIndex: number): number {
  let depth = 1
  let index = openIndex + 1

  while (index < text.length) {
    const char = text[index]

    if (char === '\\') {
      index += 2
      continue
    }

    if (char === '"') {
      const close = findStringEnd(text, index)
      if (close === -1) return -1
      index = close + 1
      continue
    }

    if (char === '%') {
      const close = findPercentEnd(text, index + 1)
      if (close === -1) return -1
      index = close + 1
      continue
    }

    if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return index
    }

    index++
  }

  return -1
}

export function findParenEnd(text: string, openIndex: number): number {
  let depth = 1
  let index = openIndex + 1

  while (index < text.length) {
    const char = text[index]

    if (char === '\\') {
      index += 2
      continue
    }

    if (char === '"') {
      const close = findStringEnd(text, index)
      if (close === -1) return -1
      index = close + 1
      continue
    }

    if (char === '{') {
      const close = findBraceEnd(text, index)
      if (close === -1) return -1
      index = close + 1
      continue
    }

    if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
      if (depth === 0) return index
    }

    index++
  }

  return -1
}

export function findBracketEnd(text: string, openIndex: number): number {
  let depth = 1
  let index = openIndex + 1

  while (index < text.length) {
    const char = text[index]

    if (char === '\\') {
      index += 2
      continue
    }

    if (char === '"') {
      const close = findStringEnd(text, index)
      if (close === -1) return -1
      index = close + 1
      continue
    }

    if (char === '{') {
      const close = findBraceEnd(text, index)
      if (close === -1) return -1
      index = close + 1
      continue
    }

    if (char === '[') {
      depth++
    } else if (char === ']') {
      depth--
      if (depth === 0) return index
    }

    index++
  }

  return -1
}

/** SkriptParser#next: bir sonraki üst düzey karakter sınırı ya da -1. */
export function nextIndex(text: string, startIndex: number): number {
  if (startIndex < 0 || startIndex >= text.length) return -1

  const char = text[startIndex]
  if (char === '"') {
    const close = findStringEnd(text, startIndex)
    return close === -1 ? -1 : close + 1
  }
  if (char === '{') {
    const close = findBraceEnd(text, startIndex)
    return close === -1 ? -1 : close + 1
  }
  if (char === '(') {
    const close = findParenEnd(text, startIndex)
    return close === -1 ? -1 : close + 1
  }
  return startIndex + 1
}

/** Metnin tırnak, süslü parantez, parantez ve köşeli parantezleri dengeli mi? */
export function isBalancedExpressionText(text: string): boolean {
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"') {
      const close = findStringEnd(text, index)
      if (close === -1) return false
      index = close + 1
      continue
    }
    if (char === '{') {
      const close = findBraceEnd(text, index)
      if (close === -1) return false
      index = close + 1
      continue
    }
    if (char === '(') {
      const close = findParenEnd(text, index)
      if (close === -1) return false
      index = close + 1
      continue
    }
    if (char === '[') {
      const close = findBracketEnd(text, index)
      if (close === -1) return false
      index = close + 1
      continue
    }
    if (char === '}' || char === ')' || char === ']' || char === '%') return false
    index++
  }
  return true
}

/** Üst düzey virgül/`and`/`or` ayırıcılarına göre listeyi böler. */
export function splitTopLevelList(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let index = 0
  let depthRound = 0
  let depthSquare = 0

  const push = (): void => {
    const trimmed = current.trim()
    if (trimmed !== '') parts.push(trimmed)
    current = ''
  }

  while (index < text.length) {
    const char = text[index]

    if (char === '\\') {
      current += text.slice(index, index + 2)
      index += 2
      continue
    }

    if (char === '"') {
      const close = findStringEnd(text, index)
      if (close === -1) return [text]
      current += text.slice(index, close + 1)
      index = close + 1
      continue
    }

    if (char === '{') {
      const close = findBraceEnd(text, index)
      if (close === -1) return [text]
      current += text.slice(index, close + 1)
      index = close + 1
      continue
    }

    if (char === '(') {
      depthRound++
    } else if (char === ')' && depthRound > 0) {
      depthRound--
    } else if (char === '[') {
      depthSquare++
    } else if (char === ']' && depthSquare > 0) {
      depthSquare--
    }

    if (depthRound === 0 && depthSquare === 0) {
      if (char === ',') {
        push()
        index++
        continue
      }
      const rest = text.slice(index)
      const andMatch = /^(?:and|or)\s+/i.exec(rest)
      if (andMatch && current.trim() !== '') {
        push()
        index += andMatch[0].length
        continue
      }
    }

    current += char
    index++
  }

  push()
  return parts.length > 1 ? parts : [text]
}
