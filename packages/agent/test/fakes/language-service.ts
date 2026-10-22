import type {
  AgentLanguageService,
  ToolCompletionItem,
  ToolDiagnostic,
  ToolHover,
  ToolLineExplanation,
  ToolScopeInfo
} from '../../src/tool'

/** Ajan tool'larını gerçek dil sunucusu olmadan sınamak için programlanabilir servis. */
export interface FakeLanguageServiceOptions {
  /** URI ve metne göre tanılar; düzenleme geri bildirimi "önce" ve "sonra" metinlerini bununla alır. */
  diagnostics?: (uri: string, text: string) => readonly ToolDiagnostic[]
  hover?: ToolHover | null
  completions?: readonly ToolCompletionItem[]
  scope?: ToolScopeInfo | null
  actions?: readonly { title: string }[]
  explanation?: ToolLineExplanation | null
  /** Tanı hesaplaması başarısız olsun (tool'un sessiz kalması test edilsin diye). */
  failDiagnostics?: boolean
}

export function fakeLanguageService(options: FakeLanguageServiceOptions = {}): AgentLanguageService {
  const diagnosticsFor = async (uri: string, text: string): Promise<readonly ToolDiagnostic[]> => {
    if (options.failDiagnostics) throw new Error('diagnostics failed')
    return options.diagnostics?.(uri, text) ?? []
  }
  const emptyExplanation: ToolLineExplanation = {
    line: 1,
    text: '',
    context: null,
    matches: [],
    candidates: [],
    otherKinds: []
  }

  const service = {
    skriptVersion: '2.17.1',
    versionWarning: null,
    selectedAddons: [],
    addonDataStatus: () => [],
    setWorkspaceFiles: () => {},
    getDiagnostics: (uri: string) => diagnosticsFor(uri, ''),
    getDiagnosticsForText: diagnosticsFor,
    getDocumentSymbols: async () => [],
    getDefinition: async () => [],
    getReferences: async () => [],
    rename: async () => null,
    getCodeActions: async () => options.actions ?? [],
    getHover: async () => options.hover ?? null,
    getCompletions: async () => options.completions ?? [],
    getScopeInfo: async () => options.scope ?? null,
    explainLine: async () => options.explanation ?? null,
    explainCode: async () => options.explanation ?? emptyExplanation
  }
  return service as unknown as AgentLanguageService
}
