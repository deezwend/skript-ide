import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseDocument, type SkriptDocument, type StructureNode } from '@skript-ide/parser'
import { listProjectFiles } from '../../attachments'
import { ToolError, type ToolContext } from '../../tool'
import { displayPath, resolveInProject } from '../core/paths'
import { isScript } from './shared'

/**
 * Dil servisine ihtiyaç duymayan statik analiz tool'larının (değişkenler, çağrı grafiği, performans,
 * komutlar, GUI önizleme) ortak parçaları: projedeki betikleri ayrıştırma ve satır içi tarama.
 */

const MAX_SCRIPT_BYTES = 1024 * 1024

export interface ParsedScript {
  /** Köke göre, `/` ile. */
  path: string
  file: string
  text: string
  doc: SkriptDocument
}

/** Projedeki tüm `.sk` dosyalarını okuyup ayrıştırır; `only` verilirse yalnızca o dosya. */
export async function readProjectScripts(ctx: ToolContext, only?: string): Promise<{ root: string; scripts: ParsedScript[] }> {
  if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
  const root = await realpath(ctx.projectRoot)
  let files: string[]
  if (only !== undefined) {
    const file = await resolveInProject(ctx, only)
    if (!isScript(file)) throw new ToolError(`${only} is not a .sk file.`)
    files = [file]
  } else {
    files = (await listProjectFiles(root)).filter(isScript).map((path) => resolve(root, path))
  }
  const scripts: ParsedScript[] = []
  for (const file of files) {
    ctx.signal.throwIfAborted()
    try {
      if ((await stat(file)).size > MAX_SCRIPT_BYTES) continue
      const text = await readFile(file, 'utf8')
      scripts.push({ path: displayPath(root, file), file, text, doc: parseDocument(text) })
    } catch {
      // Listelendikten sonra silinmiş olabilir
    }
  }
  return { root, scripts }
}

/** Satırı (0 tabanlı) içeren üst düzey yapı. */
export function structureAt(doc: SkriptDocument, line: number): StructureNode | undefined {
  return doc.structures.find((structure) => structure.range.start.line <= line && line <= structure.range.end.line)
}

/** Yapının kısa adı: `function give_kit`, `command /heal`, `on join`. */
export function structureLabel(structure: StructureNode | undefined): string {
  if (!structure) return '(top level)'
  if (structure.kind === 'function') return `function ${structure.name ?? structure.header}`
  if (structure.kind === 'command') return `command ${structure.name ?? structure.header}`
  return structure.header
}

export interface ScannedVariable {
  /** Süslü parantez içi ham ad. */
  name: string
  /** Satır metnindeki `{` konumu. */
  start: number
  end: number
  /** Başka bir değişkenin adının içinde (`{a::%{_i}%}` içindeki `_i`). */
  nested: boolean
}

const enum Mode {
  Code,
  String,
  Expression
}

/**
 * Satırdaki değişkenleri bulur. Skript'te string içindeki değişken yalnızca `%…%` içinde geçerlidir;
 * `{@option}` başvuruları atlanır. Adın içindeki `%…%` parçalarındaki değişkenler de döner.
 */
export function scanVariables(text: string, offset = 0, initial: Mode = Mode.Code, nested = false): ScannedVariable[] {
  const found: ScannedVariable[] = []
  const stack: Mode[] = [initial]
  for (let i = 0; i < text.length; i++) {
    const mode = stack[stack.length - 1]
    const ch = text[i]
    if (mode === Mode.String) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++
        else stack.pop()
      } else if (ch === '%') {
        if (text[i + 1] === '%') i++
        else stack.push(Mode.Expression)
      }
      continue
    }
    if (ch === '"') {
      stack.push(Mode.String)
    } else if (ch === '%' && mode === Mode.Expression) {
      stack.pop()
    } else if (ch === '{') {
      const end = matchingBrace(text, i)
      if (text[i + 1] !== '@') {
        const name = text.slice(i + 1, end)
        found.push({ name, start: offset + i, end: offset + end + 1, nested })
        // Adın içindeki `%…%` parçaları string gibi taranır
        found.push(...scanVariables(name, offset + i + 1, Mode.String, true).filter((v) => v.nested))
      }
      i = end
    }
    if (stack.length === 0) stack.push(Mode.Code)
  }
  return found
}

function matchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return text.length
}

/**
 * String ve süslü parantez içlerini `_` ile örter (uzunluk korunur); böylece ` to `, `,` gibi ayraçlar
 * yalnızca üst düzeyde aranır.
 */
export function maskNested(text: string): string {
  const out = [...text]
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '"' && text[i + 1] === '"') {
        out[i] = out[i + 1] = '_'
        i++
      } else if (ch === '"') {
        inString = false
      } else {
        out[i] = '_'
      }
    } else if (depth > 0) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
      if (depth > 0) out[i] = '_'
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth = 1
    }
  }
  return out.join('')
}

/** Üst düzey virgüllere göre böler (parantez, string ve değişken içleri sayılmaz). */
export function splitTopLevel(text: string, separator = ','): string[] {
  const masked = maskNested(text)
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(from, i))
      from = i + 1
    }
  }
  parts.push(text.slice(from))
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * Değişken adının biçimi: `%…%` parçaları `%` olur, böylece `coins::%player%` ile
 * `coins::%player's uuid%` aynı listeye ait görülür.
 */
export function variableShape(name: string): string {
  return name.toLowerCase().replace(/%[^%]*%/g, '%').replace(/\s+/g, ' ').trim()
}

/** İki biçim aynı değişkene/listeye karşılık gelebilir mi: `%` her parçayla, `*` kalan her şeyle eşleşir. */
export function shapesOverlap(a: string, b: string): boolean {
  const pa = a.split('::')
  const pb = b.split('::')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === '*' || y === '*') return true
    if (x === undefined || y === undefined) return false
    if (x !== y && !x.includes('%') && !y.includes('%')) return false
  }
  return true
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

/** Satırların sonuna eklenen kısaltılmış kaynak. */
export function clip(text: string, max = 120): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}
