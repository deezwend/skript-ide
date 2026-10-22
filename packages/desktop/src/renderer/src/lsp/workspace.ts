import { api } from '../api'
import { monaco } from '../monaco'
import { extname } from '../paths'

/** Dil sunucusuna gönderilen çalışma alanı anlık görüntüsü. */
export interface WorkspaceSnapshot {
  files: { uri: string; text: string }[]
  /** Tüm ağaç sınırlara takılmadan okunduysa true. */
  complete: boolean
  /** Sınır ya da okuma hatası nedeniyle atlanan dosyalar. */
  skipped: string[]
  /** Taranan toplam .sk dosyası (atlananlar dahil). */
  scanned: number
}

const MAX_DEPTH = 8
const MAX_FILES = 300
const MAX_CHARS = 256 * 1024
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.svn', '.hg'])

/** Küçük harfli URI → diskteki gerçek yazımıyla yol (sekme adları ve yinelenen sekmeleri önlemek için). */
const originalPaths = new Map<string, string>()

/** Monaco istemcisinin gönderdiği biçim: küçük harfli, `file:///c:/...`. */
export function uriForPath(path: string): string {
  const uri = monaco.Uri.file(path).toString(true).toLowerCase()
  originalPaths.set(uri, path)
  return uri
}

/** Dil sunucusundan dönen (küçük harfli) URI'nin dosya yolu; tarandıysa diskteki yazımıyla. */
export function pathForUri(uri: monaco.Uri | string): string {
  const parsed = typeof uri === 'string' ? monaco.Uri.parse(uri) : uri
  return originalPaths.get(parsed.toString(true).toLowerCase()) ?? parsed.fsPath
}

/**
 * Seçilen klasörün altındaki `.sk` dosyalarını `api.readDir` / `api.readFile` ile okur.
 * Yeni bir dosya erişim yolu açmaz; ana süreçteki izin kontrolü aynen geçerlidir.
 */
export async function readWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const files: { uri: string; text: string }[] = []
  const skipped: string[] = []
  let complete = true
  let scanned = 0

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES) {
      complete = false
      return
    }
    let entries
    try {
      entries = await api.readDir(directory)
    } catch {
      complete = false
      skipped.push(directory)
      return
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        complete = false
        return
      }
      if (entry.isDirectory) {
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue
        if (depth >= MAX_DEPTH) {
          complete = false
          skipped.push(entry.path)
          continue
        }
        await walk(entry.path, depth + 1)
        continue
      }
      if (extname(entry.path) !== '.sk') continue
      scanned++
      try {
        const text = await api.readFile(entry.path)
        if (text.length > MAX_CHARS) {
          complete = false
          skipped.push(entry.path)
          continue
        }
        files.push({ uri: uriForPath(entry.path), text })
      } catch {
        complete = false
        skipped.push(entry.path)
      }
    }
  }

  await walk(root, 0)
  return { files, complete, skipped, scanned }
}
