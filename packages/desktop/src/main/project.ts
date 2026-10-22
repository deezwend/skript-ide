import { ipcMain } from 'electron'
import { join } from 'node:path'
import {
  checkAddonSelections,
  DEFAULT_SKRIPT_VERSION,
  findAddonVersion,
  findJava,
  findRuntimeProfile,
  parseAddonSelections,
  runtimeVersionsFor,
  serializeAddonSelections,
  SKRIPT_RUNTIMES,
  type AddonSelection,
  type SkriptServer,
  type ValidationResult
} from '@skript-ide/runtime-validator'
import {
  IpcChannel,
  PROJECT_FILE_NAME,
  type ProjectState,
  type SkriptVersionOption,
  type ValidateRequest
} from '../shared/ipc'
import { readTextFile, writeTextFile } from './workspace'

import { l } from '@skript-ide/i18n'
interface ProjectFile {
  path: string
  /** Dosyadaki tüm alanlar; yazarken bilinmeyenler korunur. */
  raw: Record<string, unknown>
}

let current: ProjectState = { root: null, settings: { skriptVersion: DEFAULT_SKRIPT_VERSION }, fromFile: false }

/**
 * `skript-project.json`'u okur. Okuma ve yazma `workspace` modülünden geçer; yani yalnızca
 * kullanıcının diyalogla seçtiği klasörlerde çalışır (`allowPath` / `assertAllowed`).
 */
async function readProject(root: string): Promise<ProjectState & { file: ProjectFile }> {
  const path = join(root, PROJECT_FILE_NAME)
  const fallback = (warning?: string): ProjectState & { file: ProjectFile } => ({
    root,
    settings: { skriptVersion: DEFAULT_SKRIPT_VERSION },
    fromFile: false,
    warning,
    file: { path, raw: {} }
  })

  let text: string
  try {
    text = await readTextFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback()
    throw error
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return fallback(l(`${PROJECT_FILE_NAME} okunamadı (${(error as Error).message}); varsayılan sürüm kullanılıyor.`, `Could not read ${PROJECT_FILE_NAME} (${(error as Error).message}); using the default version.`))
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fallback(l(`${PROJECT_FILE_NAME} bir JSON nesnesi değil; varsayılan sürüm kullanılıyor.`, `${PROJECT_FILE_NAME} is not a JSON object; using the default version.`))
  }

  const fields = raw as Record<string, unknown>
  const version = fields.skriptVersion
  const state = fallback()
  state.file.raw = fields
  if (typeof fields.serverVersion === 'string') state.settings.serverVersion = fields.serverVersion
  const addons = parseAddonSelections(fields.addons)
  if (addons.selections.length > 0) state.settings.addons = addons.selections
  const addonWarnings = addons.warnings.map((warning) => `${PROJECT_FILE_NAME}: ${warning}`)

  if (typeof version !== 'string') {
    state.warning = l(`${PROJECT_FILE_NAME} içinde "skriptVersion" yok; varsayılan Skript ${DEFAULT_SKRIPT_VERSION} kullanılıyor.`, `${PROJECT_FILE_NAME} has no "skriptVersion"; using the default Skript ${DEFAULT_SKRIPT_VERSION}.`)
  } else if (!findRuntimeProfile(version)) {
    state.warning =
      l(
        `${PROJECT_FILE_NAME} Skript ${version} istiyor ama bu sürüm desteklenmiyor ` +
          `(${SKRIPT_RUNTIMES.map((p) => p.skript).join(', ')}). Varsayılan Skript ${DEFAULT_SKRIPT_VERSION} kullanılıyor.`,
        `${PROJECT_FILE_NAME} asks for Skript ${version}, which is not supported ` +
          `(${SKRIPT_RUNTIMES.map((p) => p.skript).join(', ')}). Using the default Skript ${DEFAULT_SKRIPT_VERSION}.`
      )
  } else {
    state.settings.skriptVersion = version
    state.fromFile = true
  }
  if (addonWarnings.length > 0) state.warning = [state.warning, ...addonWarnings].filter(Boolean).join(' ')
  return state
}

/** Tek bir alanı yazar; alan sırası ve bilinmeyen alanlar korunur. `skriptVersion` yoksa başa eklenir. */
async function writeProjectField(root: string, field: 'skriptVersion' | 'addons', value: unknown): Promise<void> {
  const { file } = await readProject(root)
  let next: Record<string, unknown>
  if (field in file.raw) next = { ...file.raw, [field]: value }
  else if (field === 'skriptVersion') next = { skriptVersion: value, ...file.raw }
  else next = { ...file.raw, [field]: value }
  if (field === 'addons' && Object.keys(value as object).length === 0) delete next.addons
  await writeTextFile(file.path, JSON.stringify(next, null, 2) + '\n')
}

/** Sunucuya kurulabilecek addon'lar: indirme bilgisi olan (bilinen sürüm) seçimler. */
function installableAddons(addons: readonly AddonSelection[] | undefined): AddonSelection[] {
  return (addons ?? []).filter((addon) => findAddonVersion(addon.name, addon.version))
}

function addonKey(addons: readonly AddonSelection[] | undefined): string {
  return (addons ?? []).map((addon) => `${addon.name.toLowerCase()}@${addon.version}`).sort().join(',')
}

function withIssues(state: ProjectState): ProjectState {
  return { ...state, addonIssues: checkAddonSelections(state.settings.addons ?? [], state.settings.skriptVersion) }
}

/** Her Java ana sürümü için bir kez bakılır; bulunamazsa sonraki listede tekrar denenir. */
const javaFound = new Map<number, boolean>()

async function javaAvailable(major: number): Promise<boolean> {
  if (javaFound.get(major)) return true
  const found = await findJava(major).then(
    () => true,
    () => false
  )
  javaFound.set(major, found)
  return found
}

export function setupProject(server: SkriptServer, startInBackground: () => void): void {
  /** Sunucuyu seçili sürüme geçirir; sürüm değiştiyse ve EULA onaylıysa yenisini hemen başlatır. */
  let switching: Promise<void> = Promise.resolve()
  const applyVersion = (version: string, addons: readonly AddonSelection[] | undefined = current.settings.addons): Promise<void> => {
    // Art arda gelen değişiklikler sırayla uygulansın; son seçilen kazanır
    const run = switching.then(async () => {
      const versions = { ...runtimeVersionsFor(version), addons: installableAddons(addons) }
      const changed =
        server.versions.skript !== versions.skript ||
        server.versions.minecraft !== versions.minecraft ||
        addonKey(server.versions.addons) !== addonKey(versions.addons)
      await server.switchVersions(versions)
      if (changed && (await server.isEulaAccepted())) startInBackground()
    })
    switching = run.catch(() => {})
    return run
  }

  ipcMain.handle(IpcChannel.skriptVersions, async (): Promise<SkriptVersionOption[]> => {
    const majors = [...new Set(SKRIPT_RUNTIMES.map((p) => p.java))]
    const available = new Map(await Promise.all(majors.map(async (m) => [m, await javaAvailable(m)] as const)))
    return SKRIPT_RUNTIMES.map((profile) => ({
      ...profile,
      supportedMinecraft: { ...profile.supportedMinecraft },
      isDefault: profile.skript === DEFAULT_SKRIPT_VERSION,
      javaAvailable: available.get(profile.java) ?? null
    }))
  })

  ipcMain.handle(IpcChannel.openProject, async (_event, root: unknown): Promise<ProjectState> => {
    if (root === null) {
      current = { root: null, settings: { skriptVersion: current.settings.skriptVersion }, fromFile: false }
    } else {
      const state = await readProject(String(root))
      current = { root: state.root, settings: state.settings, fromFile: state.fromFile, warning: state.warning }
    }
    await applyVersion(current.settings.skriptVersion)
    return withIssues(current)
  })

  ipcMain.handle(IpcChannel.setSkriptVersion, async (_event, version: unknown): Promise<ProjectState> => {
    const skriptVersion = String(version)
    runtimeVersionsFor(skriptVersion) // Bilinmeyen sürümü reddet
    if (current.root) {
      await writeProjectField(current.root, 'skriptVersion', skriptVersion)
      current = { ...current, settings: { ...current.settings, skriptVersion }, fromFile: true, warning: undefined }
    } else {
      current = { ...current, settings: { ...current.settings, skriptVersion } }
    }
    await applyVersion(skriptVersion)
    return withIssues(current)
  })

  ipcMain.handle(IpcChannel.setAddons, async (_event, raw: unknown): Promise<ProjectState> => {
    // Arayüzden gelen liste, proje dosyasındaki nesne biçimine çevrilip aynı ayrıştırıcıdan geçer
    const list = Array.isArray(raw) ? raw : []
    const object: Record<string, unknown> = {}
    for (const item of list) {
      const { name, version } = (item ?? {}) as { name?: unknown; version?: unknown }
      if (typeof name === 'string') object[name] = version
    }
    const { selections, warnings } = parseAddonSelections(object)
    if (warnings.length > 0) throw new Error(warnings.join(' '))
    if (current.root) await writeProjectField(current.root, 'addons', serializeAddonSelections(selections))
    current = { ...current, settings: { ...current.settings, addons: selections.length > 0 ? selections : undefined } }
    await applyVersion(current.settings.skriptVersion)
    return withIssues(current)
  })

  ipcMain.handle(
    IpcChannel.validateOnVersion,
    async (_event, version: unknown, requests: unknown): Promise<ValidationResult[]> => {
      const target = String(version)
      runtimeVersionsFor(target) // Bilinmeyen sürümü reddet
      if (!(await server.isEulaAccepted())) throw new Error(l("Gerçek sunucuda doğrulamak için önce Minecraft EULA'sını kabul et.", 'Accept the Minecraft EULA before validating on a real server.'))
      const list = (Array.isArray(requests) ? requests : []) as ValidateRequest[]
      // Hedef sürümle uyumlu addon sürümü bilinmiyorsa projenin seçimi denenir (uyumsuzsa sunucu durumu söyler)
      const original = current.settings.skriptVersion
      await applyVersion(target)
      try {
        await server.start()
        const results: ValidationResult[] = []
        for (const request of list) {
          results.push(await server.validate(String(request.source), String(request.fileName), String(request.content)))
        }
        return results
      } finally {
        await applyVersion(original)
      }
    }
  )
}
