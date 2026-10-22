import { readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DirEntry } from '../shared/ipc'

import { l } from '@skript-ide/i18n'
/**
 * Arayüz yalnızca kullanıcının bir diyalogla seçtiği klasör ve dosyalara
 * erişebilir. Arayüzde bir açık oluşsa bile diskin geri kalanı korunur.
 */
const allowedRoots = new Set<string>()

const HIDDEN_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

export function allowPath(path: string): void {
  allowedRoots.add(resolve(path))
}

function assertAllowed(path: string): string {
  const abs = resolve(path)
  for (const root of allowedRoots) {
    const rel = relative(root, abs)
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) return abs
  }
  throw new Error(l(`Bu konuma erişim izni yok: ${path}`, `No permission to access this location: ${path}`))
}

export async function listDirectory(dir: string): Promise<DirEntry[]> {
  const abs = assertAllowed(dir)
  const entries = await readdir(abs, { withFileTypes: true })
  return entries
    .filter((entry) => !HIDDEN_ENTRIES.has(entry.name))
    .map((entry) => ({ name: entry.name, path: join(abs, entry.name), isDirectory: entry.isDirectory() }))
    .sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' })
        : a.isDirectory ? -1 : 1
    )
}

export function readTextFile(path: string): Promise<string> {
  return readFile(assertAllowed(path), 'utf8')
}

export function writeTextFile(path: string, content: string): Promise<void> {
  return writeFile(assertAllowed(path), content, 'utf8')
}
