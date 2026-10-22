import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ToolError, type ToolContext } from '../../tool'

/**
 * LLM'in verdiği yolu proje köküne göre çözer; kökün dışına (`..`, mutlak yol, sembolik bağ) çıkarsa reddeder.
 * Hedef var olmalı: tüm temel tool'lar var olan dosyalarla çalışır.
 */
export async function resolveInProject(ctx: ToolContext, path: string): Promise<string> {
  if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
  const root = await realpath(ctx.projectRoot)
  const target = resolve(root, path)
  let real: string
  try {
    real = await realpath(target)
  } catch {
    throw new ToolError(`Path not found: ${path}`)
  }
  if (!isInside(root, real)) throw new ToolError(`Path is outside the project: ${path}`)
  return real
}

/**
 * Henüz var olmayabilecek bir hedef için `resolveInProject`: var olan en yakın üst klasörün gerçek yolu
 * kökün içinde olmalı (sembolik bağla dışarı kaçılamaz). Dönen yol, eksik klasörlerle birlikte hedeftir.
 */
export async function resolveTargetInProject(ctx: ToolContext, path: string): Promise<string> {
  if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
  const root = await realpath(ctx.projectRoot)
  const target = resolve(root, path)
  if (!isInside(root, target) || target === root) throw new ToolError(`Path is outside the project: ${path}`)
  const missing: string[] = []
  let existing = target
  for (;;) {
    try {
      existing = await realpath(existing)
      break
    } catch {
      missing.unshift(basename(existing))
      const parent = dirname(existing)
      if (parent === existing) throw new ToolError(`Path not found: ${path}`)
      existing = parent
    }
  }
  if (!isInside(root, existing)) throw new ToolError(`Path is outside the project: ${path}`)
  return join(existing, ...missing)
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Sonuçlarda gösterilen yol: proje köküne göre, her platformda `/` ile. */
export function displayPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/') || '.'
}

/** Aramada ve listelemede atlanan klasörler. */
export const IGNORED_DIRS = new Set(['.git', 'node_modules', 'out', 'dist'])

/** Proje dosyalarını gezer; yok sayılan klasörlere ve sembolik bağlara (proje dışına çıkabilirler) girmez. */
export async function* walkFiles(dir: string, ctx: ToolContext): AsyncGenerator<string> {
  ctx.signal.throwIfAborted()
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walkFiles(full, ctx)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

/**
 * Glob desenini `/` ile yazılmış göreli yollarla eşleşen düzenli ifadeye çevirir (büyük/küçük harf duyarsız).
 * `**` klasör sınırlarını geçer, `*` ve `?` geçmez; `{a,b}` ve `[abc]` desteklenir.
 * `/` içermeyen desen her derinlikteki dosya adıyla eşleşir (`*.sk`, `**` + `/*.sk` gibidir).
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/\\/g, '/').replace(/^\.\//, '')
  const source = pattern.includes('/') ? pattern : `**/${pattern}`
  let out = ''
  let braces = 0
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '*') {
      if (source[i + 1] === '*') {
        // `**/` sıfır ya da daha çok klasör; sondaki `**` her şey
        if (source[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i++
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '[') {
      const close = source.indexOf(']', i + 1)
      if (close === -1) {
        out += '\\['
      } else {
        const body = source.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')
        out += `[${body}]`
        i = close
      }
    } else if (char === '{') {
      braces++
      out += '(?:'
    } else if (char === '}' && braces > 0) {
      braces--
      out += ')'
    } else if (char === ',' && braces > 0) {
      out += '|'
    } else {
      out += escapeRegExp(char)
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
