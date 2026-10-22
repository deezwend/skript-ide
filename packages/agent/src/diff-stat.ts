import type { FileChange } from './tool'

/** Bir tool çağrısının dosyalarda eklediği/sildiği satır sayısı; arayüz `+eklenen -silinen` gösterir. */
export interface DiffStat {
  added: number
  removed: number
}

/** Bu kadar farktan sonra tam diff aranmaz; ortak baş/son dışındaki her satır değişmiş sayılır. */
const MAX_EDIT_DISTANCE = 4000

/** Son satır sonu ayrı bir boş satır sayılmasın diye atılır; boş metin sıfır satırdır. */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Myers: en kısa ekle/sil dizisinin uzunluğu; `max`'ı aşarsa `null`. */
function editDistance(a: readonly number[], b: readonly number[], max: number): number | null {
  const n = a.length
  const m = b.length
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return d
    }
  }
  return null
}

/** İki metin arasındaki satır farkı. */
export function lineDiffStat(before: string, after: string): DiffStat {
  const a = splitLines(before)
  const b = splitLines(after)
  // Ortak baş ve son atlanır; düzenlemelerin çoğu küçük olduğu için Myers'a az satır kalır
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if (n === 0 || m === 0) return { added: m, removed: n }

  // Satırlar sayıya çevrilir; karşılaştırma hızlı olsun
  const ids = new Map<string, number>()
  const id = (line: string): number => {
    let value = ids.get(line)
    if (value === undefined) ids.set(line, (value = ids.size))
    return value
  }
  const ia = a.slice(start, endA).map(id)
  const ib = b.slice(start, endB).map(id)
  const distance = editDistance(ia, ib, Math.min(n + m, MAX_EDIT_DISTANCE))
  if (distance === null) return { added: m, removed: n }
  // d = n + m - 2·ortak
  const common = (n + m - distance) / 2
  return { added: m - common, removed: n - common }
}

/** Bir çağrının tüm değişikliklerinin toplamı; taşınan dosya eski içeriğiyle karşılaştırılır. */
export function changesDiffStat(changes: readonly FileChange[]): DiffStat {
  const movedFrom = new Map<string, string>()
  for (const change of changes) if (change.deleted) movedFrom.set(change.path, change.before)
  const movedSources = new Set(changes.flatMap((change) => (change.movedFrom ? [change.movedFrom] : [])))
  const total: DiffStat = { added: 0, removed: 0 }
  for (const change of changes) {
    if (change.deleted && movedSources.has(change.path)) continue
    const before = change.movedFrom ? (movedFrom.get(change.movedFrom) ?? '') : change.before
    const stat = lineDiffStat(before, change.after)
    total.added += stat.added
    total.removed += stat.removed
  }
  return total
}
