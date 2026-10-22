import { shell } from 'electron'
import { access, cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

/** Gezginde girilen ad: boş, yol ayırıcılı ya da `.`/`..` olamaz. */
function assertValidName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/:*?"<>|]/.test(trimmed)) {
    throw new Error(l(`Geçersiz ad: "${name}"`, `Invalid name: "${name}"`))
  }
  return trimmed
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

async function assertFree(path: string): Promise<void> {
  if (await exists(path)) {
    throw new Error(l(`Bu adla bir öğe zaten var: ${basename(path)}`, `An item with this name already exists: ${basename(path)}`))
  }
}

export async function createFile(dir: string, name: string): Promise<string> {
  const path = assertAllowed(join(assertAllowed(dir), assertValidName(name)))
  await assertFree(path)
  await writeFile(path, '', { encoding: 'utf8', flag: 'wx' })
  return path
}

export async function createDirectory(dir: string, name: string): Promise<string> {
  const path = assertAllowed(join(assertAllowed(dir), assertValidName(name)))
  await assertFree(path)
  await mkdir(path)
  return path
}

export async function renamePath(path: string, newName: string): Promise<string> {
  const source = assertAllowed(path)
  const target = assertAllowed(join(dirname(source), assertValidName(newName)))
  if (target === source) return source
  // Windows'ta yalnızca büyük/küçük harf değişikliği aynı dosyayı gösterir; o zaman çakışma sayılmaz
  if (target.toLowerCase() !== source.toLowerCase()) await assertFree(target)
  await rename(source, target)
  return target
}

/** Geri dönüşüm kutusuna taşır; kalıcı silme yapılmaz. */
export async function trashPath(path: string): Promise<void> {
  const abs = assertAllowed(path)
  if (allowedRoots.has(abs)) throw new Error(l('Açık klasörün kendisi silinemez.', 'The open folder itself cannot be deleted.'))
  await shell.trashItem(abs)
}

/** Hedefte aynı ad varsa "ad - kopya.sk", "ad - kopya 2.sk" … biçiminde boş bir ad bulur. */
async function freeCopyPath(dir: string, name: string, isDirectory: boolean): Promise<string> {
  let candidate = join(dir, name)
  if (!(await exists(candidate))) return candidate
  const ext = isDirectory ? '' : extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  const copy = l('kopya', 'copy')
  for (let n = 1; ; n++) {
    candidate = join(dir, `${stem} - ${copy}${n > 1 ? ` ${n}` : ''}${ext}`)
    if (!(await exists(candidate))) return candidate
  }
}

/**
 * `source` öğesini `targetDir` içine kopyalar ya da taşır; yeni yolu döner.
 * Bir klasör kendi içine kopyalanamaz ya da taşınamaz.
 */
export async function transferPath(source: string, targetDir: string, move: boolean): Promise<string> {
  const from = assertAllowed(source)
  const dir = assertAllowed(targetDir)
  const rel = relative(from, dir)
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) {
    throw new Error(l('Bir klasör kendi içine kopyalanamaz.', 'A folder cannot be copied into itself.'))
  }
  if (move && dirname(from) === dir) return from
  const isDirectory = (await stat(from)).isDirectory()
  const target = assertAllowed(await freeCopyPath(dir, basename(from), isDirectory))
  if (!move) {
    await cp(from, target, { recursive: true, errorOnExist: true, force: false })
    return target
  }
  try {
    await rename(from, target)
  } catch (error) {
    // Farklı sürücüler arasında rename çalışmaz; kopyalayıp kaynağı çöpe at
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(from, target, { recursive: true, errorOnExist: true, force: false })
    await shell.trashItem(from)
  }
  return target
}

export function revealPath(path: string): void {
  shell.showItemInFolder(assertAllowed(path))
}
