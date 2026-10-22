/**
 * Derlenmiş Skript pattern'lerinin AST'si.
 *
 * Biçim Skript'in `ch.njol.skript.patterns` paketindeki elemanlarla birebir örtüşür:
 * literal, opsiyonel (`[ ]`), grup (`( )`), seçim (`a|b`), yer tutucu (`%tip%`),
 * regex (`<...>`) ve parse mark/tag düğümleri.
 */

export interface PlaceholderInfo {
  /** Yazıldığı gibi tür adları, ör. ['living entities'], ['entity types','entity snapshots'] (`/` ile ayrılmış). */
  readonly types: readonly string[]
  /** `%-type%`: null/boş geçilebilir (opsiyonel bağlamda). */
  readonly nullable: boolean
  /** `%*type%`: yalnızca literal kabul eder. */
  readonly literalOnly: boolean
  /** `%~type%`: yalnızca değiştirilebilir (variable vb.) ifade. */
  readonly changeable: boolean
  /** Çoğul tür adı mı (`%players%`). */
  readonly plural: boolean
  /** Varsa `@-1`, `@1` gibi zaman eki. */
  readonly time?: number
}

export interface SequenceNode {
  readonly type: 'sequence'
  readonly nodes: readonly PatternNode[]
}

export interface LiteralNode {
  readonly type: 'literal'
  readonly text: string
}

export interface OptionalNode {
  readonly type: 'optional'
  readonly node: PatternNode
}

export interface GroupNode {
  readonly type: 'group'
  readonly node: PatternNode
}

export interface ChoiceNode {
  readonly type: 'choice'
  readonly alternatives: readonly PatternNode[]
}

export interface PlaceholderNode {
  readonly type: 'placeholder'
  readonly info: PlaceholderInfo
  /** `%` içindeki ham metin (bayraklar ve `@zaman` dahil). */
  readonly raw: string
}

export interface RegexNode {
  readonly type: 'regex'
  /** `<` ve `>` arasındaki Java regex kaynağı. */
  readonly source: string
}

export interface ParseTagNode {
  readonly type: 'parse-tag'
  /** `null` = eski biçim parse mark (`1¦`), aksi halde tag metni. */
  readonly tag: string | null
  /** Eşleşmede XOR ile birleştirilir. */
  readonly mark: number
}

export type PatternNode =
  | SequenceNode
  | LiteralNode
  | OptionalNode
  | GroupNode
  | ChoiceNode
  | PlaceholderNode
  | RegexNode
  | ParseTagNode

/** Yalnızca eşleşmenin kesinlikle içermesi gereken literal kelimeler (küçük harf). */
export function collectRequiredWords(node: PatternNode): string[] {
  function visit(current: PatternNode): Set<string> {
    switch (current.type) {
      case 'literal':
        return new Set(literalWords(current.text))
      case 'optional':
        // Opsiyonel kısım hiç geçmeyebilir.
        return new Set()
      case 'choice': {
        let intersection: Set<string> | null = null
        for (const alternative of current.alternatives) {
          const alternativeWords = collectStrict(alternative)
          if (intersection === null) {
            intersection = new Set(alternativeWords)
          } else {
            for (const word of [...intersection]) {
              if (!alternativeWords.has(word)) intersection.delete(word)
            }
          }
        }
        return intersection ?? new Set()
      }
      case 'group':
        return collectStrict(current.node)
      case 'sequence':
        return collectStrict(current)
      case 'placeholder':
      case 'regex':
      case 'parse-tag':
        return new Set()
    }
  }

  function collectStrict(current: PatternNode): Set<string> {
    if (current.type === 'sequence') {
      const result = new Set<string>()
      for (const child of current.nodes) {
        for (const word of visit(child)) result.add(word)
      }
      return result
    }
    return visit(current)
  }

  return [...collectStrict(node)]
}

/** Ön süzme için literal metinden kelimeler çıkarır. */
export function literalWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Yer tutucu sayısı (seçeneklerin en fazlası değil, toplamı; sıralama için yeterli). */
export function countPlaceholders(node: PatternNode): number {
  switch (node.type) {
    case 'sequence':
      return node.nodes.reduce((total, child) => total + countPlaceholders(child), 0)
    case 'choice':
      return node.alternatives.reduce((total, child) => total + countPlaceholders(child), 0)
    case 'optional':
    case 'group':
      return countPlaceholders(node.node)
    case 'placeholder':
      return 1
    default:
      return 0
  }
}

/** Eşleşme sıralamasında kullanılan literal karakter toplamı. */
export function countLiteralChars(node: PatternNode): number {
  switch (node.type) {
    case 'sequence':
      return node.nodes.reduce((total, child) => total + countLiteralChars(child), 0)
    case 'choice':
      return node.alternatives.reduce((total, child) => total + countLiteralChars(child), 0)
    case 'optional':
    case 'group':
      return countLiteralChars(node.node)
    case 'literal':
      return node.text.length
    default:
      return 0
  }
}

/** Tür adının İngilizce çoğul biçimde yazılıp yazılmadığına dair muhafazakâr tahmin. */
export function isPluralTypeName(name: string): boolean {
  const trimmed = name.trim().toLowerCase()
  if (trimmed === '') return false
  const lastWord = trimmed.split(/[\s/]+/).pop() ?? ''
  if (['people', 'children', 'men', 'women', 'mice', 'geese', 'feet', 'teeth'].includes(lastWord)) {
    return true
  }
  if (/(?:ss|us|is)$/.test(lastWord)) return false
  return lastWord.endsWith('s')
}
