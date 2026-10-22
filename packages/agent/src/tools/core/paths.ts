import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
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
