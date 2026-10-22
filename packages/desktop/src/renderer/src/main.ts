import './styles.css'
import './locale'
import { SKRIPT_LANGUAGE_ID } from '@skript-ide/skript-language'
import {
  PROJECT_FILE_NAME,
  type MenuAction,
  type ProjectState,
  type ServerState,
  type ServerStatus,
  type SkriptVersionOption
} from '../../shared/ipc'
import { pickAddons } from './addon-picker'
import { api } from './api'
import { ServerConsole } from './console'
import { DocumentManager, type OpenDocument } from './documents'
import { Explorer } from './explorer'
import { SkriptLspClient, type LspStatus, type MigrationItem } from './lsp/client'
import { applySemanticTheme, SKRIPT_LSP_THEME_ID } from './lsp/theme'
import { pathForUri, readWorkspace, uriForPath } from './lsp/workspace'
import { MigrationView, type MigrationValidation } from './migration-view'
import { languageName, monaco } from './monaco'
import { OutlinePanel } from './outline'
import { basename, dirname, extname, samePath } from './paths'
import { ProblemsPanel } from './problems'
import { SyntaxBrowser } from './syntax-browser'
import { renderTabs } from './tabs'

import { l } from '@skript-ide/i18n'
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!

// Semantic token kuralları başlangıçta tanımlansın; sunucunun legend'i gelince yeniden uygulanır.
applySemanticTheme()

const editor = monaco.editor.create($('#editor'), {
  model: null,
  theme: SKRIPT_LSP_THEME_ID,
  automaticLayout: true,
  fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
  fontSize: 14,
  fontLigatures: true,
  tabSize: 4,
  // Skript girinti tabanlı; boşluk/tab karışımı en sık hata kaynağı, o yüzden görünür olsun
  insertSpaces: false,
  detectIndentation: true,
  // 'full': `else:` yazılınca satırı otomatik olarak bir seviye geri alır
  autoIndent: 'full',
  renderWhitespace: 'boundary',
  guides: { indentation: true, highlightActiveIndentation: true },
  minimap: { enabled: true },
  smoothScrolling: true,
  cursorSmoothCaretAnimation: 'on',
  scrollBeyondLastLine: false,
  stickyScroll: { enabled: true },
  bracketPairColorization: { enabled: true },
  'semanticHighlighting.enabled': true
})

const docs = new DocumentManager(editor, (model) => languageServer.adoptModel(model))

// LSP tanımı başka bir modele işaret ediyorsa Monaco'nun varsayılanı hiçbir şey yapmaz;
// sekmeyi DocumentManager üzerinden açıp konuma git.
monaco.editor.registerEditorOpener({
  openCodeEditor: async (_source, resource, selectionOrPosition) => {
    try {
      let doc = docs.documents.find((candidate) => {
        const uri = candidate.model.uri.toString(true).toLowerCase()
        return uri === resource.toString(true).toLowerCase()
      })
      if (!doc) {
        if (resource.scheme !== 'file') return false
        doc = await docs.open(pathForUri(resource))
      }
      docs.activate(doc.id)
      if (selectionOrPosition) {
        if ('startLineNumber' in selectionOrPosition) {
          editor.setSelection(selectionOrPosition)
          editor.revealRangeInCenter(selectionOrPosition)
        } else {
          editor.setPosition(selectionOrPosition)
          editor.revealPositionInCenter(selectionOrPosition)
        }
      }
      editor.focus()
      return true
    } catch (error) {
      console.error(l('Tanım hedefi açılamadı:', 'Could not open definition target:'), error)
      return false
    }
  }
})

let outline: OutlinePanel | null = null

// İstemci kurulurken durumu hemen bildirdiği için etiketler ondan önce tanımlı olmalı
const LSP_LABELS: Record<LspStatus['state'], (detail?: string) => string> = {
  starting: () => l('⟳ Skript LS: yükleniyor…', '⟳ Skript LS: loading…'),
  ready: () => l('✓ Skript LS: hazır', '✓ Skript LS: ready'),
  restarting: () => l('⟳ Skript LS: yeniden başlatılıyor…', '⟳ Skript LS: restarting…'),
  error: () => l('✕ Skript LS: hata', '✕ Skript LS: error')
}

const languageServer = new SkriptLspClient({
  onStatus: renderLspStatus,
  onLegend: (legend) => {
    applySemanticTheme(legend)
    monaco.editor.setTheme(SKRIPT_LSP_THEME_ID)
  },
  // Yeniden adlandırma / hızlı düzeltme açık olmayan dosyalara dokunuyorsa düzenleme
  // geri alınabilsin ve kaydedilebilsin diye onları sekmede aç; odak eski sekmede kalsın.
  openEditTargets: async (paths) => {
    const previous = docs.active
    for (const path of paths) await docs.open(path)
    if (previous) docs.activate(previous.id)
  }
})

const explorer = new Explorer(
  $('#explorer'),
  (path) => void run(() => docs.open(path)),
  () => void run(actions['open-folder'])
)

// --- Durum çubuğu ---

let statusTimer: number | undefined
function showStatus(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('#status-message')
  el.textContent = message
  el.className = kind
  window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => (el.textContent = ''), 5000)
}

function updateCursorStatus(): void {
  const position = editor.getPosition()
  $('#status-cursor').textContent = position ? l(`Satır ${position.lineNumber}, Sütun ${position.column}`, `Ln ${position.lineNumber}, Col ${position.column}`) : ''
}

function updateIndentStatus(): void {
  const options = docs.active?.model.getOptions()
  $('#status-indent').textContent = options
    ? options.insertSpaces ? l(`Boşluk: ${options.tabSize}`, `Spaces: ${options.tabSize}`) : `Tab: ${options.tabSize}`
    : ''
}

async function run(action: () => unknown): Promise<void> {
  try {
    await action()
  } catch (error) {
    console.error(error)
    showStatus((error as Error).message, 'error')
  }
}

// --- Alt panel ---

type PanelView = 'problems' | 'console'

const serverConsole = new ServerConsole(
  $('#terminal'),
  $<HTMLInputElement>('#console-input'),
  $<HTMLFormElement>('#console-form'),
  (error) => showStatus(error.message, 'error')
)

const problems = new ProblemsPanel($('#problems'), $('#problem-count'), docs, (source, line, column) =>
  void run(() => revealProblem(source, line, column))
)

outline = new OutlinePanel($('#outline'), editor, docs, (uri) => languageServer.requestDocumentSymbols(uri))

function showPanel(view: PanelView): void {
  document.querySelectorAll<HTMLElement>('[data-panel]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.panel === view)
    tab.setAttribute('aria-selected', String(tab.dataset.panel === view))
  })
  $('#panel-problems').hidden = view !== 'problems'
  $('#panel-console').hidden = view !== 'console'
  if (view === 'console') serverConsole.show()
}

document.querySelectorAll<HTMLElement>('[data-panel]').forEach((tab) => {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel as PanelView))
})

async function revealProblem(source: string, line: number, column = 0): Promise<void> {
  // Kapatılmış bir dosyanın sorununa tıklanırsa dosyayı yeniden aç
  const doc = docs.findBySource(source) ?? (source.startsWith('untitled:') ? null : await docs.open(source))
  if (!doc) return
  docs.activate(doc.id)
  const target = column > 0 ? column : doc.model.getLineFirstNonWhitespaceColumn(line) || 1
  editor.setPosition({ lineNumber: line, column: target })
  editor.revealLineInCenter(line)
  editor.focus()
}

// --- Doğrulama sunucusu ---

let serverStatus: ServerStatus | null = null

const SERVER_LABELS: Record<ServerState, (status: ServerStatus) => string> = {
  stopped: () => l('○ Sunucu kapalı', '○ Server stopped'),
  'eula-required': () => l('⚠ Sunucu: EULA onayı gerekli', '⚠ Server: EULA acceptance required'),
  preparing: (status) => l(`⟳ Sunucu hazırlanıyor — ${status.message}`, `⟳ Preparing server — ${status.message}`),
  starting: () => l('⟳ Sunucu hazırlanıyor — başlatılıyor…', '⟳ Preparing server — starting…'),
  ready: () => l('✓ Sunucu hazır', '✓ Server ready'),
  validating: () => l('⟳ Doğrulanıyor…', '⟳ Validating…'),
  stopping: () => l('○ Sunucu durduruluyor…', '○ Stopping server…'),
  error: () => l('✕ Sunucu hatası', '✕ Server error')
}

// --- Dil sunucusu ---

function renderLspStatus(status: LspStatus): void {
  const item = $('#status-lsp')
  item.textContent = LSP_LABELS[status.state](status.detail)
  item.dataset.state = status.state
  const title = l('Skript dil sunucusu', 'Skript language server')
  const hint = l('Yeniden başlatmak için tıkla', 'Click to restart')
  item.title = status.detail ? `${title}\n${status.detail}\n${hint}` : `${title}\n${hint}`
  if (status.state === 'ready') outline?.refresh()
}

function renderServerStatus(status: ServerStatus): void {
  serverStatus = status
  const item = $('#status-server')
  item.textContent = SERVER_LABELS[status.state](status)
  item.dataset.state = status.state
  item.title = `${status.message}\nPaper ${status.versions.minecraft} · Skript ${status.versions.skript}`

  // Kullanıcının bir şey yapması gereken durumlar Problemler sekmesinin üstünde de görünsün
  const notice = $('#server-notice')
  notice.hidden = status.state !== 'eula-required' && status.state !== 'error'
  notice.dataset.state = status.state
  $('#server-notice-text').textContent =
    status.state === 'eula-required'
      ? l("Betikleri doğrulayabilmek için yerel test sunucusunun Minecraft EULA'sını kabul etmen gerekiyor.", 'To validate scripts, you need to accept the Minecraft EULA for the local test server.')
      : status.message
  $('#server-notice-action').textContent =
    status.state === 'eula-required' ? l("EULA'yı Gör", 'View EULA') : l('Yeniden Dene', 'Retry')
}

/** EULA penceresini açar; kullanıcı kabul ederse onayı ana sürece iletir. */
function askEula(): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('#eula-dialog')
  $<HTMLInputElement>('#eula-checkbox').checked = false
  $<HTMLButtonElement>('#eula-accept').disabled = true
  if (serverStatus) $<HTMLAnchorElement>('#eula-link').href = serverStatus.eulaUrl
  dialog.returnValue = ''
  dialog.showModal()
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue !== 'accept') return resolve(false)
        api.acceptEula().then(
          () => resolve(true),
          (error: Error) => {
            showStatus(error.message, 'error')
            resolve(false)
          }
        )
      },
      { once: true }
    )
  })
}

$<HTMLInputElement>('#eula-checkbox').addEventListener('change', (event) => {
  $<HTMLButtonElement>('#eula-accept').disabled = !(event.target as HTMLInputElement).checked
})

async function startServer(): Promise<void> {
  if (serverStatus?.state === 'eula-required') {
    await askEula()
    return
  }
  // Başlatma hatası durum çubuğuna ve uyarı şeridine zaten yansıyor
  await api.startServer().catch(() => {})
}

$('#server-notice-action').addEventListener('click', () => void run(startServer))
$('#status-lsp').addEventListener('click', () => {
  showStatus(l('Skript dil sunucusu yeniden başlatılıyor…', 'Restarting the Skript language server…'))
  languageServer.restart()
})
$('#status-server').addEventListener('click', () => {
  const state = serverStatus?.state
  if (state === 'eula-required' || state === 'error' || state === 'stopped') void run(startServer)
  else showPanel('console')
})

async function validate(doc: OpenDocument | null = docs.active): Promise<void> {
  if (!doc) return
  if (doc.model.getLanguageId() !== SKRIPT_LANGUAGE_ID) {
    showStatus(l('Yalnızca Skript (.sk) dosyaları doğrulanabilir', 'Only Skript (.sk) files can be validated'), 'error')
    return
  }
  if (serverStatus?.state === 'eula-required' && !(await askEula())) return

  const title = docs.title(doc)
  const result = await api.validate({ source: docs.sourceId(doc), fileName: title, content: doc.model.getValue() })
  problems.setResult(result)

  const errors = result.diagnostics.filter((d) => d.severity === 'error').length
  const warnings = result.diagnostics.length - errors
  if (result.diagnostics.length === 0) {
    showStatus(l(`${title}: sorun bulunamadı`, `${title}: no problems found`))
  } else {
    showStatus(l(`${title}: ${errors} hata, ${warnings} uyarı`, `${title}: ${errors} errors, ${warnings} warnings`), errors ? 'error' : 'info')
    showPanel('problems')
  }
}

/** Kaydettikten sonra Skript dosyasını arka planda doğrula; kaydetme mesajını bekletme. */
function validateAfterSave(doc: OpenDocument | null): void {
  if (doc?.model.getLanguageId() === SKRIPT_LANGUAGE_ID) void run(() => validate(doc))
}

// --- Kenar çubuğu görünümleri ---

type SidebarView = 'explorer' | 'outline' | 'syntax'

const syntaxBrowser = new SyntaxBrowser({
  search: $<HTMLInputElement>('#syntax-search'),
  kind: $<HTMLSelectElement>('#syntax-kind'),
  source: $<HTMLSelectElement>('#syntax-source'),
  count: $('#syntax-count'),
  results: $('#syntax-results'),
  detail: $('#syntax-detail')
})

function showSidebar(view: SidebarView): void {
  $('#sidebar').dataset.view = view
  document.querySelectorAll<HTMLElement>('[data-sidebar-view]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.sidebarView === view)
    tab.setAttribute('aria-selected', String(tab.dataset.sidebarView === view))
  })
  $('#sidebar-explorer').hidden = view !== 'explorer'
  $('#sidebar-outline').hidden = view !== 'outline'
  $('#sidebar-syntax').hidden = view !== 'syntax'
  if (view === 'outline') outline?.refresh()
  if (view === 'syntax') {
    if (project) void run(() => syntaxBrowser.setVersion(project!.settings.skriptVersion))
    syntaxBrowser.focusSearch()
  }
}

document.querySelectorAll<HTMLElement>('[data-sidebar-view]').forEach((tab) => {
  tab.addEventListener('click', () => showSidebar(tab.dataset.sidebarView as SidebarView))
})

// --- Proje ve Skript sürümü ---

let project: ProjectState | null = null
let versionOptions: SkriptVersionOption[] = []

function applyProject(state: ProjectState): void {
  project = state
  const version = state.settings.skriptVersion
  const item = $('#status-skript')
  item.textContent = `Skript ${version}`
  const option = versionOptions.find((o) => o.skript === version)
  item.title =
    (option ? `Paper ${option.minecraft} · Java ${option.java}+\n` : '') +
    (state.root
      ? state.fromFile
        ? l(`${PROJECT_FILE_NAME} dosyasından`, `From ${PROJECT_FILE_NAME}`)
        : l(`${PROJECT_FILE_NAME} yok; varsayılan sürüm`, `No ${PROJECT_FILE_NAME}; default version`)
      : l('Klasör açılmadı; seçim yalnızca bu oturum için', 'No folder open; the choice applies to this session only')) +
    l('\nDeğiştirmek için tıkla', '\nClick to change')
  if (state.warning) showStatus(state.warning, 'error')
  languageServer.setSkriptVersion(version)
  const addons = state.settings.addons ?? []
  languageServer.setAddons(addons)
  void run(() => syntaxBrowser.setAddons(addons))
  renderAddonStatus(state)
  // Syntax Tarayıcısı açık değilse veriyi gereksiz yere yükleme
  if (!$('#sidebar-syntax').hidden || syntaxBrowser.currentVersion !== null) void run(() => syntaxBrowser.setVersion(version))
}

function renderAddonStatus(state: ProjectState): void {
  const item = $('#status-addons')
  const addons = state.settings.addons ?? []
  const issues = state.addonIssues ?? []
  item.textContent = addons.length ? `Addon: ${addons.map((addon) => addon.name).join(', ')}` : l('Addon yok', 'No addons')
  if (issues.length) item.textContent = `⚠ ${item.textContent}`
  item.classList.toggle('warning', issues.length > 0)
  item.title =
    (addons.length ? addons.map((addon) => `${addon.name} ${addon.version}`).join('\n') : l('Seçili addon yok', 'No addons selected')) +
    (issues.length ? `\n\n${issues.map((issue) => issue.message).join('\n')}` : '') +
    l('\nDeğiştirmek için tıkla', '\nClick to change')
}

$('#status-addons').addEventListener('click', () => void run(actions.addons))

// --- Sürüm Geçiş Asistanı ---

function fileLabel(uri: string): string {
  // Kaydedilmemiş belgelerin adresi `inmemory://`; sekme adını göster
  if (!uri.toLowerCase().startsWith('file:')) {
    const key = monaco.Uri.parse(uri).toString(true).toLowerCase()
    const doc = docs.documents.find((candidate) => candidate.model.uri.toString(true).toLowerCase() === key)
    return doc ? docs.title(doc) : uri
  }
  const path = pathForUri(uri)
  const root = project?.root
  if (root && path.toLowerCase().startsWith(root.toLowerCase())) return path.slice(root.length).replace(/^[\\/]+/, '')
  return basename(path)
}

async function documentForUri(uri: string): Promise<OpenDocument | null> {
  const key = monaco.Uri.parse(uri).toString(true).toLowerCase()
  const open = docs.documents.find((doc) => doc.model.uri.toString(true).toLowerCase() === key)
  if (open) return open
  return monaco.Uri.parse(uri).scheme === 'file' ? docs.open(pathForUri(uri)) : null
}

const toMonacoRange = (range: MigrationItem['range']) =>
  new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1)

async function applyMigrationFixes(items: MigrationItem[]): Promise<number> {
  const previous = docs.active
  const byUri = new Map<string, MigrationItem[]>()
  for (const item of items) {
    if (!item.fix) continue
    byUri.set(item.uri, [...(byUri.get(item.uri) ?? []), item])
  }
  let applied = 0
  for (const [uri, fixes] of byUri) {
    const doc = await documentForUri(uri)
    if (!doc) continue
    // Rapordan sonra değişmiş satırlara dokunma
    const edits = fixes
      .filter((item) => item.line < doc.model.getLineCount() && doc.model.getLineContent(item.line + 1).trim() === item.text.trim())
      .map((item) => ({ range: toMonacoRange(item.fix!.range), text: item.fix!.newText }))
    if (edits.length === 0) continue
    doc.model.pushStackElement()
    doc.model.pushEditOperations(null, edits, () => null)
    doc.model.pushStackElement()
    applied += edits.length
  }
  if (previous) docs.activate(previous.id)
  showStatus(l(`${applied} geçiş düzeltmesi uygulandı; dosyaları kaydetmeyi unutma`, `${applied} migration fixes applied; don't forget to save the files`))
  return applied
}

async function validateProjectOnVersion(version: string): Promise<MigrationValidation[]> {
  const root = project?.root
  if (!root) throw new Error(l('Gerçek sunucuda doğrulamak için bir proje klasörü aç.', 'Open a project folder to validate on a real server.'))
  if (serverStatus?.state === 'eula-required' && !(await askEula())) throw new Error(l("EULA kabul edilmedi.", 'The EULA was not accepted.'))
  const snapshot = await readWorkspace(root)
  // Açık sekmelerdeki kaydedilmemiş içerik de denensin
  const requests = snapshot.files.map((file) => {
    const path = pathForUri(file.uri)
    const doc = docs.documents.find((candidate) => candidate.path !== null && samePath(candidate.path, path))
    return { source: path, fileName: basename(path), content: doc ? doc.model.getValue() : file.text }
  })
  if (requests.length === 0) throw new Error(l('Projede .sk dosyası yok.', 'The project has no .sk files.'))
  const results = await api.validateOnVersion(version, requests)
  return results.map((result) => {
    const errors = result.diagnostics.filter((d) => d.severity === 'error')
    return {
      file: fileLabel(uriForPath(result.source)),
      ok: result.ok,
      errors: errors.length,
      warnings: result.diagnostics.length - errors.length,
      messages: result.diagnostics.map((d) => `${d.line}: ${d.message}`)
    }
  })
}

const migrationView = new MigrationView($<HTMLDialogElement>('#migration-dialog'), {
  versions: () => versionOptions.map((option) => option.skript),
  currentVersion: () => project?.settings.skriptVersion ?? '',
  requestReport: (from, to) => languageServer.requestMigrationReport(from, to),
  reveal: async (item) => {
    const doc = await documentForUri(item.uri)
    if (!doc) return
    docs.activate(doc.id)
    const range = toMonacoRange(item.range)
    editor.setSelection(range)
    editor.revealRangeInCenter(range)
    editor.focus()
  },
  applyFixes: applyMigrationFixes,
  validateOnServer: validateProjectOnVersion,
  switchVersion: async (version) => applyProject(await api.setSkriptVersion(version)),
  fileLabel
})

const picker = $('#version-picker')

function closeVersionPicker(): void {
  picker.hidden = true
  $('#status-skript').setAttribute('aria-expanded', 'false')
}

async function openVersionPicker(): Promise<void> {
  versionOptions = await api.listSkriptVersions()
  const current = project?.settings.skriptVersion
  const header = document.createElement('div')
  header.className = 'picker-header'
  header.textContent = project?.root
    ? l(`Skript sürümü — ${PROJECT_FILE_NAME} dosyasına kaydedilir`, `Skript version — saved to ${PROJECT_FILE_NAME}`)
    : l('Skript sürümü — klasör açılmadığı için yalnızca bu oturum', 'Skript version — this session only, since no folder is open')

  const rows = versionOptions.map((option) => {
    const row = document.createElement('button')
    row.className = 'picker-row'
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(option.skript === current))
    row.classList.toggle('current', option.skript === current)

    const title = document.createElement('span')
    title.className = 'picker-title'
    title.textContent = `Skript ${option.skript}${option.isDefault ? l(' (varsayılan)', ' (default)') : ''}`
    const detail = document.createElement('span')
    detail.className = 'picker-detail'
    detail.textContent =
      `Paper ${option.minecraft} · Java ${option.java}+ · MC ${option.supportedMinecraft.min} – ${option.supportedMinecraft.max}\n` + option.note
    row.append(title, detail)
    if (option.javaAvailable === false) {
      const warning = document.createElement('span')
      warning.className = 'picker-warning'
      warning.textContent = l(`⚠ Bu bilgisayarda Java ${option.java} veya üstü bulunamadı`, `⚠ Java ${option.java} or newer was not found on this computer`)
      row.append(warning)
    }
    row.addEventListener('click', () => {
      closeVersionPicker()
      void run(() => selectSkriptVersion(option))
    })
    return row
  })

  // Sürüm değiştirmeden önce projenin hedef sürümde neyin bozulacağını görmek için
  const migration = document.createElement('button')
  migration.className = 'picker-row picker-footer'
  migration.textContent = l('Sürüm Geçiş Asistanı…', 'Version Migration Assistant…')
  migration.addEventListener('click', () => {
    closeVersionPicker()
    void run(actions.migration)
  })

  picker.replaceChildren(header, ...rows, migration)
  picker.hidden = false
  $('#status-skript').setAttribute('aria-expanded', 'true')
  ;(picker.querySelector<HTMLElement>('.picker-row.current') ?? rows[0])?.focus()
}

async function selectSkriptVersion(option: SkriptVersionOption): Promise<void> {
  if (option.skript === project?.settings.skriptVersion) return
  applyProject(await api.setSkriptVersion(option.skript))
  if (option.javaAvailable === false) {
    showStatus(
      l(
        `Skript ${option.skript} seçildi, ama doğrulama sunucusu (Paper ${option.minecraft}) için Java ${option.java} veya üstü gerekiyor ` +
          `ve bu bilgisayarda bulunamadı. https://adoptium.net adresinden Java ${option.java} kurabilirsin.`,
        `Skript ${option.skript} selected, but the validation server (Paper ${option.minecraft}) needs Java ${option.java} or newer ` +
          `and it was not found on this computer. You can install Java ${option.java} from https://adoptium.net.`
      ),
      'error'
    )
  } else {
    showStatus(l(`Skript ${option.skript} seçildi — doğrulama sunucusu Paper ${option.minecraft} ile yeniden hazırlanıyor`, `Skript ${option.skript} selected — preparing the validation server again with Paper ${option.minecraft}`))
  }
  problems.clear()
}

$('#status-skript').addEventListener('click', (event) => {
  event.stopPropagation()
  if (picker.hidden) void run(openVersionPicker)
  else closeVersionPicker()
})

picker.addEventListener('keydown', (event) => {
  const rows = [...picker.querySelectorAll<HTMLElement>('.picker-row')]
  const index = rows.indexOf(document.activeElement as HTMLElement)
  if (event.key === 'Escape') {
    closeVersionPicker()
    $('#status-skript').focus()
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0)
    rows[next]?.focus()
  }
})

document.addEventListener('mousedown', (event) => {
  if (!picker.hidden && !picker.contains(event.target as Node) && event.target !== $('#status-skript')) closeVersionPicker()
})

/** Kullanıcı `skript-project.json`'u editörde düzenleyip kaydederse ayarı yeniden oku. */
function reloadProjectIfSettingsSaved(doc: OpenDocument | null): void {
  const root = project?.root
  if (!root || !doc?.path) return
  if (basename(doc.path) === PROJECT_FILE_NAME && samePath(dirname(doc.path), root)) {
    void run(async () => applyProject(await api.openProject(root)))
  }
}

// --- Komutlar ---

/** Açılan klasörün Skript dosyalarını dil sunucusuna gönderir. */
async function syncWorkspace(root: string): Promise<void> {
  showStatus(l('Çalışma alanı taranıyor…', 'Scanning workspace…'))
  const snapshot = await readWorkspace(root)
  languageServer.setWorkspaceFiles(snapshot.files, snapshot.complete)
  const suffix = snapshot.complete
    ? ''
    : l(
        ` (${snapshot.skipped.length} öğe sınır ya da okuma hatası nedeniyle atlandı)`,
        ` (${snapshot.skipped.length} items skipped due to limits or read errors)`
      )
  showStatus(l(`${snapshot.files.length} Skript dosyası dil sunucusuna gönderildi${suffix}`, `Sent ${snapshot.files.length} Skript files to the language server${suffix}`))
}

function notifySavedFile(doc: OpenDocument | null): void {
  if (!doc?.path || extname(doc.path) !== '.sk') return
  languageServer.workspaceFileChanged(uriForPath(doc.path), doc.model.getValue())
}

const actions: Record<MenuAction, () => unknown> = {
  'new-file': () => docs.newUntitled(),
  'open-file': async () => {
    const paths = await api.openFileDialog()
    for (const path of paths) await docs.open(path)
  },
  'open-folder': async () => {
    const folder = await api.openFolderDialog()
    if (!folder) return
    await explorer.setRoot(folder)
    // Klasörün skript-project.json'u varsa sürüm ona göre seçilir ve sunucu o sürüme geçer
    applyProject(await api.openProject(folder))
    await syncWorkspace(folder)
  },
  save: async () => {
    const doc = docs.active
    if (!doc) return
    // Adsız belge kaydedilince yol değişir; sunucu sonuçları yeni kaynağa taşınır
    const previousSource = docs.sourceId(doc)
    if (!(await docs.save(doc))) return
    showStatus(l('Kaydedildi', 'Saved'))
    problems.renameSource(previousSource, docs.sourceId(doc))
    notifySavedFile(doc)
    reloadProjectIfSettingsSaved(doc)
    validateAfterSave(doc)
  },
  'save-as': async () => {
    const doc = docs.active
    if (!doc) return
    const previousPath = doc.path
    const previousSource = docs.sourceId(doc)
    if (!(await docs.saveAs(doc))) return
    showStatus(l('Kaydedildi', 'Saved'))
    problems.renameSource(previousSource, docs.sourceId(doc))
    // Eski yol çalışma alanı anlık görüntüsünde kalmasın
    if (previousPath && doc.path && !samePath(previousPath, doc.path)) {
      languageServer.workspaceFileChanged(uriForPath(previousPath), null)
    }
    notifySavedFile(doc)
    reloadProjectIfSettingsSaved(doc)
    validateAfterSave(doc)
  },
  'close-tab': () => docs.close(),
  validate: () => validate(),
  addons: async () => {
    if (!project) return
    const selection = await pickAddons(
      $<HTMLDialogElement>('#addon-dialog'),
      project.settings.addons ?? [],
      project.settings.skriptVersion
    )
    if (!selection) return
    applyProject(await api.setAddons(selection))
    showStatus(
      project.root
        ? l(`Addon seçimi ${PROJECT_FILE_NAME} dosyasına yazıldı`, `Addon selection written to ${PROJECT_FILE_NAME}`)
        : l('Addon seçimi yalnızca bu oturum için', 'Addon selection applies to this session only')
    )
  },
  migration: async () => {
    if (versionOptions.length === 0) versionOptions = await api.listSkriptVersions()
    migrationView.open()
  },
  'go-to-symbol': () => {
    if (!docs.active) {
      showStatus(l('Sembole gitmek için önce bir dosya aç', 'Open a file first to go to a symbol'), 'error')
      return
    }
    editor.trigger('menu', 'editor.action.quickOutline', null)
  }
}

api.onMenuAction((action) => void run(actions[action]))

// --- Başlık çubuğu ---

document.body.classList.add(`platform-${api.platform}`)
window.addEventListener('blur', () => document.body.classList.add('window-inactive'))
window.addEventListener('focus', () => document.body.classList.remove('window-inactive'))

void api.getMenuLabels().then((labels) => {
  const menu = $('#titlebar-menu')
  labels.forEach((label, index) => {
    const button = document.createElement('button')
    button.textContent = label
    button.setAttribute('role', 'menuitem')
    button.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const rect = button.getBoundingClientRect()
      button.classList.add('open')
      void api.popupMenu(index, rect.left, rect.bottom).finally(() => button.classList.remove('open'))
    })
    menu.append(button)
  })
})

document.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
  el.addEventListener('click', () => void run(actions[el.dataset.action as MenuAction]))
})

// --- Görünümü belgelerle eşitle ---

function render(): void {
  const active = docs.active
  renderTabs($('#tabs'), docs)
  explorer.setActive(active?.path ?? null)
  $('#welcome').hidden = active !== null
  $('#status-language').textContent = active ? languageName(active.model.getLanguageId()) : ''
  updateCursorStatus()
  updateIndentStatus()

  const anyDirty = docs.documents.some((doc) => docs.isDirty(doc))
  document.title = active ? `${anyDirty ? '● ' : ''}${docs.title(active)} — Skript IDE` : 'Skript IDE'
  $('#titlebar-title').textContent = document.title
}

docs.onChange(render)
docs.onChange(() => problems.sync())
editor.onDidChangeCursorPosition(updateCursorStatus)
editor.onDidChangeModelOptions(updateIndentStatus)
render()

api.onServerStatus(renderServerStatus)
void api.getServerStatus().then(renderServerStatus)
void serverConsole.connect()

// Klasör açılmadan önce de seçili bir sürüm olsun (varsayılan ya da bu oturumda seçilen)
void run(async () => {
  versionOptions = await api.listSkriptVersions()
  applyProject(await api.openProject(null))
})

if (import.meta.env.DEV) {
  // Geliştirirken konsoldan erişmek için
  Object.assign(window, {
    __skriptIde: { editor, docs, monaco, problems, syntaxBrowser, languageServer, outline }
  })
}
