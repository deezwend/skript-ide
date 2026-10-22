import type { Position, Range, SkriptDocument } from './contracts'

/** URI karşılaştırması büyük/küçük harf duyarsızdır (Monaco istemcisi URI'leri küçük harfe çevirir). */
export function uriKey(uri: string): string {
  return uri.toLowerCase()
}

export function containsPosition(range: Range, position: Position, inclusiveEnd = true): boolean {
  const afterStart =
    position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character)
  if (!afterStart) return false
  if (inclusiveEnd) {
    return (
      position.line < range.end.line ||
      (position.line === range.end.line && position.character <= range.end.character)
    )
  }
  return (
    position.line < range.end.line ||
    (position.line === range.end.line && position.character < range.end.character)
  )
}

export function rangesIntersect(a: Range, b: Range): boolean {
  return !rangeBefore(a, b) && !rangeBefore(b, a)
}

function rangeBefore(a: Range, b: Range): boolean {
  return (
    a.end.line < b.start.line ||
    (a.end.line === b.start.line && a.end.character <= b.start.character)
  )
}

/** Metni satırlara böler; `\r\n` ve `\n` desteklenir, satır sonu karakterleri içermez. */
export function textLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/)
}

export function lineAt(text: string, line: number): string {
  return textLines(text)[line] ?? ''
}

export function offsetAt(text: string, position: Position): number {
  const lines = textLines(text)
  let offset = 0
  for (let index = 0; index < position.line && index < lines.length; index += 1) {
    offset += lines[index].length + 1
  }
  return offset + Math.min(position.character, lines[position.line]?.length ?? 0)
}

export function positionAt(text: string, offset: number): Position {
  const lines = textLines(text)
  let remaining = Math.max(0, offset)
  for (let line = 0; line < lines.length; line += 1) {
    if (remaining <= lines[line].length) return { line, character: remaining }
    remaining -= lines[line].length + 1
  }
  const last = lines.length - 1
  return { line: last, character: lines[last]?.length ?? 0 }
}

export function lineRange(line: number, start: number, length: number): Range {
  return { start: { line, character: start }, end: { line, character: start + length } }
}

export function lineTextRange(doc: SkriptDocument, line: number): Range {
  const info = doc.lines[line]
  const start = info?.start ?? 0
  return lineRange(line, start, info?.text.length ?? 0)
}

const IDENTIFIER = /[\p{L}\p{N}_-]/u

/** Konumun içinde bulunduğu (ya da hemen bitişiğindeki) tanımlayıcıyı döndürür. */
export function identifierAt(
  text: string,
  position: Position
): { name: string; range: Range } | null {
  const lines = textLines(text)
  const line = lines[position.line]
  if (line === undefined) return null
  const clamped = Math.min(position.character, line.length)
  let start = clamped
  let end = clamped
  while (start > 0 && IDENTIFIER.test(line[start - 1])) start -= 1
  while (end < line.length && IDENTIFIER.test(line[end])) end += 1
  if (start === end) return null
  return {
    name: line.slice(start, end),
    range: { start: { line: position.line, character: start }, end: { line: position.line, character: end } }
  }
}

/** İmleçten geriye doğru tanımlayıcı benzeri sözcüğün başlangıcı. */
export function wordStart(line: string, character: number): number {
  let start = Math.min(character, line.length)
  while (start > 0 && IDENTIFIER.test(line[start - 1])) start -= 1
  return start
}

/** Karşılaştırma için "2.10 (multiple)" gibi sürümleri sayı dizisine indirger. */
export function versionParts(version: string): number[] {
  const match = /(\d+(?:\.\d+)*)/.exec(version)
  if (!match) return [0]
  return match[1].split('.').map((part) => Number.parseInt(part, 10) || 0)
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function versionDistance(from: string, to: string): number {
  const left = versionParts(from)
  const right = versionParts(to)
  const length = Math.max(left.length, right.length)
  let distance = 0
  for (let index = 0; index < length; index += 1) {
    distance = distance * 100 + Math.abs((left[index] ?? 0) - (right[index] ?? 0))
  }
  return distance
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+.!|>~-]/g, '\\$&')
}

export function foldName(name: string): string {
  return name.toLowerCase()
}
