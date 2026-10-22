import {
  CodeActionKind,
  ErrorCodes,
  ResponseError,
  RegistrationRequest,
  TextDocumentSyncKind,
  TextDocuments,
  type ClientCapabilities,
  type Connection,
  type InitializeResult,
  type Registration,
  type ServerCapabilities
} from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { SEMANTIC_TOKENS_LEGEND } from './semantic-tokens'
import { SkriptLanguageService, type AddonSelectionInput, type LanguageServiceOptions } from './service'
import { uriKey } from './util'

import { l, parseLocale, setLocale } from '@skript-ide/i18n'
export const COMPLETION_TRIGGER_CHARACTERS = ['{', '@', '%', '.'] as const
const DOCUMENT_SELECTOR = [{ language: 'skript' }]
const DEBOUNCE_MS = 180

interface DynamicSupport {
  completion: boolean
  hover: boolean
  definition: boolean
  references: boolean
  documentSymbol: boolean
  semanticTokens: boolean
}

function dynamicSupport(capabilities: ClientCapabilities | undefined): DynamicSupport {
  return {
    completion: capabilities?.textDocument?.completion?.dynamicRegistration === true,
    hover: capabilities?.textDocument?.hover?.dynamicRegistration === true,
    definition: capabilities?.textDocument?.definition?.dynamicRegistration === true,
    references: capabilities?.textDocument?.references?.dynamicRegistration === true,
    documentSymbol: capabilities?.textDocument?.documentSymbol?.dynamicRegistration === true,
    semanticTokens: capabilities?.textDocument?.semanticTokens?.dynamicRegistration === true
  }
}

function initializationVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const version = (value as { skriptVersion?: unknown }).skriptVersion
  return typeof version === 'string' && version.trim() ? version.trim() : undefined
}

function configurationVersion(settings: unknown): string | undefined {
  if (!settings || typeof settings !== 'object') return undefined
  const skript = (settings as { skript?: unknown }).skript
  if (skript && typeof skript === 'object') {
    const version = (skript as { version?: unknown }).version
    if (typeof version === 'string' && version.trim()) return version.trim()
  }
  const direct = (settings as { skriptVersion?: unknown }).skriptVersion
  return typeof direct === 'string' && direct.trim() ? direct.trim() : undefined
}

/**
 * Addon seçimi iki biçimde kabul edilir: proje dosyasındaki gibi `{ "SkBee": "3.26.0" }` ya da
 * `[{ name, version }]`. Tanınmayan değerde `undefined` (seçim değişmez).
 */
export function parseAddonsSetting(value: unknown): AddonSelectionInput[] | undefined {
  if (value === undefined || value === null) return undefined
  const selections: AddonSelectionInput[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const { name, version } = item as { name?: unknown; version?: unknown }
      if (typeof name === 'string' && typeof version === 'string') selections.push({ name, version })
    }
    return selections
  }
  if (typeof value !== 'object') return undefined
  for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
    if (typeof version === 'string') selections.push({ name, version })
  }
  return selections
}

function settingsAddons(settings: unknown): AddonSelectionInput[] | undefined {
  if (!settings || typeof settings !== 'object') return undefined
  const skript = (settings as { skript?: unknown }).skript
  if (skript && typeof skript === 'object' && 'addons' in skript) {
    return parseAddonsSetting((skript as { addons?: unknown }).addons)
  }
  return parseAddonsSetting((settings as { addons?: unknown }).addons)
}

/**
 * Bir `Connection` üzerindeki tüm LSP handler'larını bağlar. Taşıma (stdio / worker) burada bilinmez.
 * `connection.listen()` çağırmak giriş noktalarının sorumluluğundadır.
 */
export function startServer(connection: Connection, options: LanguageServiceOptions): SkriptLanguageService {
  const service = new SkriptLanguageService(options)
  const documents = new TextDocuments(TextDocument)
  const analyzed = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  let support = dynamicSupport(undefined)
  let pendingVersion: string | undefined

  const isSkript = (document: TextDocument | undefined): document is TextDocument =>
    document !== undefined && document.languageId === 'skript'

  const schedule = (uri: string, delay: number): void => {
    const key = uriKey(uri)
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(key)
      void publish(uri)
    }, delay)
    timers.set(key, timer)
  }

  const publish = async (uri: string): Promise<void> => {
    const document = documents.get(uri)
    if (!isSkript(document)) return
    const expectedVersion = document.version
    try {
      const diagnostics = await service.getDiagnostics(uri)
      const latest = documents.get(uri)
      if (!isSkript(latest)) return
      if (latest.version !== expectedVersion) {
        schedule(uri, DEBOUNCE_MS)
        return
      }
      await connection.sendDiagnostics({ uri, diagnostics, version: latest.version })
    } catch (error) {
      connection.console.error(
        `[skript-ls] diagnostics üretilemedi (${uri}): ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const republishAll = (delay: number): void => {
    for (const document of service.listOpenDocuments()) schedule(document.uri, delay)
  }

  const applyVersion = async (requested: string | undefined): Promise<void> => {
    if (!requested) return
    await service.setSkriptVersion(requested)
    if (service.versionWarning || service.skriptVersion !== requested) {
      void connection.window.showWarningMessage(
        l(`Skript ${requested} için syntax veritabanı bulunamadı; ${service.skriptVersion} sürümü kullanılıyor.`, `No syntax database found for Skript ${requested}; using ${service.skriptVersion}.`)
      )
    }
    republishAll(0)
  }

  documents.onDidOpen((event) => {
    if (!isSkript(event.document)) return
    analyzed.add(uriKey(event.document.uri))
    service.openDocument(event.document.uri, event.document.getText(), event.document.version)
    schedule(event.document.uri, 0)
  })

  documents.onDidChangeContent((event) => {
    if (!isSkript(event.document) || !analyzed.has(uriKey(event.document.uri))) return
    service.updateDocument(event.document.uri, event.document.getText(), event.document.version)
    schedule(event.document.uri, DEBOUNCE_MS)
  })

  documents.onDidClose((event) => {
    const key = uriKey(event.document.uri)
    if (!analyzed.delete(key)) return
    const timer = timers.get(key)
    if (timer) {
      clearTimeout(timer)
      timers.delete(key)
    }
    service.closeDocument(event.document.uri)
    void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] })
  })

  documents.listen(connection)

  connection.onInitialize((params) => {
    // Mesajlar istemcinin dilinde üretilsin (LSP `locale` alanı, ör. "en" ya da "tr-TR")
    const locale = parseLocale(params.locale)
    if (locale) setLocale(locale)
    support = dynamicSupport(params.capabilities)
    pendingVersion = initializationVersion(params.initializationOptions)
    const addons = settingsAddons(params.initializationOptions)
    if (addons) service.setAddons(addons)

    const serverCapabilities: ServerCapabilities = {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: support.hover ? undefined : true,
      definitionProvider: support.definition ? undefined : true,
      referencesProvider: support.references ? undefined : true,
      documentSymbolProvider: support.documentSymbol ? undefined : true,
      completionProvider: support.completion
        ? undefined
        : { triggerCharacters: [...COMPLETION_TRIGGER_CHARACTERS], resolveProvider: false },
      semanticTokensProvider: support.semanticTokens
        ? undefined
        : { legend: SEMANTIC_TOKENS_LEGEND, full: true },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      renameProvider: { prepareProvider: true }
    }
    const result: InitializeResult = {
      capabilities: serverCapabilities,
      serverInfo: { name: 'skript-language-server', version: '0.1.0' }
    }
    return result
  })

  connection.onInitialized(() => {
    void (async () => {
      await applyVersion(pendingVersion)
      await registerDynamicCapabilities()
    })()
  })

  const registerDynamicCapabilities = async (): Promise<void> => {
    const registrations: Registration[] = []
    if (support.completion) {
      registrations.push({
        id: 'skript-completion',
        method: 'textDocument/completion',
        registerOptions: {
          documentSelector: DOCUMENT_SELECTOR,
          triggerCharacters: [...COMPLETION_TRIGGER_CHARACTERS],
          resolveProvider: false
        }
      })
    }
    if (support.hover) {
      registrations.push({ id: 'skript-hover', method: 'textDocument/hover', registerOptions: { documentSelector: DOCUMENT_SELECTOR } })
    }
    if (support.definition) {
      registrations.push({
        id: 'skript-definition',
        method: 'textDocument/definition',
        registerOptions: { documentSelector: DOCUMENT_SELECTOR }
      })
    }
    if (support.references) {
      registrations.push({
        id: 'skript-references',
        method: 'textDocument/references',
        registerOptions: { documentSelector: DOCUMENT_SELECTOR }
      })
    }
    if (support.documentSymbol) {
      registrations.push({
        id: 'skript-document-symbols',
        method: 'textDocument/documentSymbol',
        registerOptions: { documentSelector: DOCUMENT_SELECTOR }
      })
    }
    if (support.semanticTokens) {
      // Monaco 0.57 dinamik kayıtta `textDocument/semanticTokens/full` yöntemini arıyor
      // (spec'teki `textDocument/semanticTokens` değil); taşıma katmanı bunu bekliyor.
      registrations.push({
        id: 'skript-semantic-tokens',
        method: 'textDocument/semanticTokens/full',
        registerOptions: {
          documentSelector: DOCUMENT_SELECTOR,
          legend: SEMANTIC_TOKENS_LEGEND,
          full: true
        }
      })
    }
    if (registrations.length === 0) return
    try {
      await connection.sendRequest(RegistrationRequest.type, { registrations })
    } catch (error) {
      connection.console.warn(
        `[skript-ls] dinamik yetenek kaydı başarısız: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  connection.onCompletion((params) => {
    if (!isSkript(documents.get(params.textDocument.uri))) return null
    return service.getCompletions(params.textDocument.uri, params.position)
  })

  connection.onHover((params) => {
    if (!isSkript(documents.get(params.textDocument.uri))) return null
    return service.getHover(params.textDocument.uri, params.position)
  })

  connection.onDefinition((params) => {
    if (!isSkript(documents.get(params.textDocument.uri))) return null
    return service.getDefinition(params.textDocument.uri, params.position)
  })

  connection.onReferences((params) => {
    if (!isSkript(documents.get(params.textDocument.uri))) return null
    return service.getReferences(
      params.textDocument.uri,
      params.position,
      params.context.includeDeclaration
    )
  })

  connection.onDocumentSymbol((params) => {
    if (!isSkript(documents.get(params.textDocument.uri))) return null
    return service.getDocumentSymbols(params.textDocument.uri)
  })

  connection.onCodeAction((params) => {
    if (!isSkript(documents.get(params.textDocument.uri))) return null
    return service.getCodeActions(params.textDocument.uri, params.range)
  })

  connection.onPrepareRename((params) => {
    if (!isSkript(documents.get(params.textDocument.uri))) return null
    return service.prepareRename(params.textDocument.uri, params.position)
  })

  connection.onRenameRequest((params) => {
    if (!isSkript(documents.get(params.textDocument.uri))) return null
    return service.rename(params.textDocument.uri, params.position, params.newName)
  })

  connection.languages.semanticTokens.on((params) => {
    if (!isSkript(documents.get(params.textDocument.uri))) return null
    return service.getSemanticTokens(params.textDocument.uri)
  })

  connection.onDidChangeConfiguration((params) => {
    const addons = settingsAddons(params.settings)
    const addonsChanged = addons ? service.setAddons(addons) : false
    const version = configurationVersion(params.settings)
    if (version) void applyVersion(version)
    else if (addonsChanged) republishAll(0)
  })

  /** Seçili addon'ların hangi syntax verisiyle tanındığı (arayüz "en yakın sürüm verisi" notu için). */
  /** Geçiş asistanı raporu: `{ from, to }` → `MigrationReport`. */
  connection.onRequest('skript/migrationReport', (params: { from?: unknown; to?: unknown }) => {
    if (typeof params?.from !== 'string' || typeof params?.to !== 'string') {
      throw new ResponseError(ErrorCodes.InvalidParams, l('from ve to sürümleri gerekli.', 'Both from and to versions are required.'))
    }
    return service.getMigrationReport(params.from, params.to)
  })

  connection.onRequest('skript/addonStatus', () => ({
    skriptVersion: service.skriptVersion,
    addons: service.addonDataStatus()
  }))

  connection.onNotification('skript/workspaceFiles', (params: unknown) => {
    if (!params || typeof params !== 'object') return
    const candidate = params as { files?: unknown; complete?: unknown }
    if (!Array.isArray(candidate.files)) return
    const files: { uri: string; text: string }[] = []
    for (const file of candidate.files) {
      if (!file || typeof file !== 'object') continue
      const entry = file as { uri?: unknown; text?: unknown }
      if (typeof entry.uri === 'string' && typeof entry.text === 'string') {
        files.push({ uri: entry.uri, text: entry.text })
      }
    }
    service.setWorkspaceFiles(files, candidate.complete === true)
    republishAll(DEBOUNCE_MS)
  })

  connection.onNotification('skript/workspaceFileChanged', (params: unknown) => {
    if (!params || typeof params !== 'object') return
    const entry = params as { uri?: unknown; text?: unknown }
    if (typeof entry.uri !== 'string') return
    if (entry.text !== null && typeof entry.text !== 'string') return
    service.updateWorkspaceFile(entry.uri, entry.text ?? null)
    republishAll(DEBOUNCE_MS)
  })

  return service
}
