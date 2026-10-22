import { lsp, type editor } from 'monaco-editor'
import type { AddonDataStatus, MigrationItem, MigrationReport } from '@skript-ide/language-server'
import type { SemanticTokensLegend } from './theme'
import { SkriptLspTransport, type LspConnectionStatus } from './transport'

export interface LspStatus {
  state: LspConnectionStatus
  detail?: string
}

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

/** Sunucudan gelen ham `DocumentSymbol` (konumlar 0 tabanlı). */
export interface LspDocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}

export type { AddonDataStatus, MigrationItem, MigrationReport }

export interface AddonSelectionSetting {
  name: string
  version: string
}

function createWorker(): Worker {
  return new Worker(new URL('./server.worker.ts', import.meta.url), {
    type: 'module',
    name: 'skript-language-server'
  })
}

/**
 * Monaco'nun kendi LSP istemcisini (`lsp.MonacoLspClient`) Skript dil sunucusuna bağlar.
 * Durum, semantic token legend'i ve uygulamaya özel istekler/bildirimler burada toplanır.
 */
export class SkriptLspClient {
  readonly transport: SkriptLspTransport
  readonly client: InstanceType<typeof lsp.MonacoLspClient>
  private currentStatus: LspStatus = { state: 'starting' }

  constructor(
    options: {
      onStatus: (status: LspStatus) => void
      onLegend: (legend: SemanticTokensLegend) => void
      /** Yeniden adlandırmanın değiştireceği dosyaları sekmede açar. */
      openEditTargets?: (paths: string[]) => Promise<void>
    }
  ) {
    this.transport = new SkriptLspTransport({
      createWorker,
      onState: (state, detail) => {
        this.currentStatus = { state, detail }
        options.onStatus(this.currentStatus)
      },
      onLegend: options.onLegend,
      prepareEditTargets: options.openEditTargets
    })
    // İstemci tüm sağlayıcıları kendisi kaydeder; bağlantı ömrü boyunca yaşaması için saklanır.
    this.client = new lsp.MonacoLspClient(
      this.transport as unknown as ConstructorParameters<typeof lsp.MonacoLspClient>[0]
    )
  }

  get status(): LspStatus {
    return this.currentStatus
  }

  private configuration: { version?: string; addons: AddonSelectionSetting[] } = { addons: [] }

  setSkriptVersion(version: string): void {
    this.configuration.version = version
    this.sendConfiguration()
  }

  /** Seçili addon'lar; tamamlama, hover ve tanılar bu addon'ların syntax'larını da tanır. */
  setAddons(addons: AddonSelectionSetting[]): void {
    this.configuration.addons = addons.map(({ name, version }) => ({ name, version }))
    this.sendConfiguration()
  }

  /** Taşıma yalnızca son yapılandırmayı yeniden oynattığı için sürüm ve addon'lar birlikte gönderilir. */
  private sendConfiguration(): void {
    this.transport.notify('workspace/didChangeConfiguration', { settings: { skript: { ...this.configuration } } })
  }

  requestAddonStatus(): Promise<{ skriptVersion: string; addons: AddonDataStatus[] } | null> {
    return this.transport.request('skript/addonStatus', null, 8000) as Promise<{
      skriptVersion: string
      addons: AddonDataStatus[]
    } | null>
  }

  /** Geçiş asistanı raporu; büyük çalışma alanında birkaç saniye sürebilir. */
  requestMigrationReport(from: string, to: string): Promise<MigrationReport> {
    return this.transport.request('skript/migrationReport', { from, to }, 60_000) as Promise<MigrationReport>
  }

  setWorkspaceFiles(files: { uri: string; text: string }[], complete: boolean): void {
    this.transport.notify('skript/workspaceFiles', { files, complete })
  }

  workspaceFileChanged(uri: string, text: string | null): void {
    this.transport.notify('skript/workspaceFileChanged', { uri, text })
  }

  /** Tanım için arka planda oluşturulmuş model sekmede açıldığında taşıma onu dispose etmemeli. */
  adoptModel(model: editor.ITextModel): void {
    this.transport.adoptModel(model)
  }

  requestDocumentSymbols(uri: string): Promise<LspDocumentSymbol[] | null> {
    return this.transport
      .request<LspDocumentSymbol[]>('textDocument/documentSymbol', { textDocument: { uri: uri.toLowerCase() } }, 4000)
      .then((result) => (Array.isArray(result) ? result : null))
  }

  restart(): void {
    this.transport.restart()
  }

  dispose(): void {
    this.transport.dispose()
  }
}
