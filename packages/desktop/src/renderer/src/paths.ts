/** Arayüzde Node `path` modülü yok; Windows ve POSIX yolları için küçük yardımcılar. */

export function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function extname(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index > 0 ? path.slice(0, index) : path
}

/** İki yol aynı yeri mi gösteriyor (ayırıcı ve Windows'ta büyük/küçük harf farkı yok sayılır). */
export function samePath(a: string, b: string): boolean {
  const normalize = (path: string) => path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}
