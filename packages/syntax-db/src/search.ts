import type { SyntaxDatabase, SyntaxEntry, SyntaxKind } from './schema'

export interface SearchOptions {
  /** Yalnızca bu türlerde ara; verilmezse hepsinde. */
  kinds?: readonly SyntaxKind[]
  /** En fazla kaç sonuç dönsün (varsayılan: sınırsız). */
  limit?: number
}

interface IndexedEntry {
  entry: SyntaxEntry
  name: string
  id: string
  patterns: string
  keywords: string
  description: string
}

/** Arama alanlarındaki eşleşme ağırlıkları: ad en önemli, açıklama en az. */
const WEIGHTS = { name: 8, patterns: 4, id: 3, keywords: 3, description: 1 } as const

function fold(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/** Bir veritabanı üzerinde basit, bağımlılıksız tam metin araması. */
export class SyntaxIndex {
  private readonly indexed: IndexedEntry[]
  private readonly byKey = new Map<string, SyntaxEntry>()

  constructor(readonly database: SyntaxDatabase) {
    this.indexed = database.entries.map((entry) => ({
      entry,
      name: fold(entry.name),
      id: fold(entry.id),
      patterns: fold(entry.patterns.join('\n')),
      keywords: fold((entry.keywords ?? []).join(' ')),
      description: fold(entry.description)
    }))
    for (const entry of database.entries) this.byKey.set(SyntaxIndex.key(entry), entry)
  }

  /** Kayıtlar yalnızca tür içinde benzersiz olduğundan anahtar `tür:kimlik` biçimindedir. */
  static key(entry: Pick<SyntaxEntry, 'kind' | 'id'>): string {
    return `${entry.kind}:${entry.id}`
  }

  get(kind: SyntaxKind, id: string): SyntaxEntry | undefined {
    return this.byKey.get(`${kind}:${id}`)
  }

  /**
   * Sorgudaki her kelime kaydın bir alanında geçmeli. Sonuçlar alaka puanına göre, eşitlikte
   * veritabanındaki sıraya (tür, ad) göre sıralanır. Boş sorgu tüm kayıtları döndürür.
   */
  search(query: string, options: SearchOptions = {}): SyntaxEntry[] {
    const kinds = options.kinds?.length ? new Set(options.kinds) : null
    const phrase = fold(query.trim())
    const words = phrase.split(/\s+/).filter(Boolean)
    const results: { entry: SyntaxEntry; score: number; order: number }[] = []

    this.indexed.forEach((item, order) => {
      if (kinds && !kinds.has(item.entry.kind)) return
      if (words.length === 0) {
        results.push({ entry: item.entry, score: 0, order })
        return
      }
      let score = 0
      for (const word of words) {
        let best = 0
        for (const field of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]) {
          if (item[field].includes(word)) best = Math.max(best, WEIGHTS[field])
        }
        if (best === 0) return
        score += best
      }
      // Tam ifade eşleşmelerini öne al
      if (item.name === phrase) score += 100
      else if (item.name.startsWith(phrase)) score += 40
      else if (item.name.includes(phrase)) score += 20
      if (item.patterns.includes(phrase)) score += 10
      if (item.id === phrase) score += 30
      results.push({ entry: item.entry, score, order })
    })

    results.sort((a, b) => b.score - a.score || a.order - b.order)
    const limited = options.limit === undefined ? results : results.slice(0, options.limit)
    return limited.map((result) => result.entry)
  }
}
