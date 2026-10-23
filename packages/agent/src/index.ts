/**
 * `@skript-ide/agent`: IDE'nin AI agent çekirdeği. Electron'dan ve LLM sağlayıcısından bağımsızdır;
 * masaüstü uygulaması bunu ana süreçte çalıştırır, sağlayıcıyı `ModelProvider` ile verir.
 */
export {
  imageDataUrl,
  IMAGE_MEDIA_TYPES,
  isImageMediaType,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGES_PER_MESSAGE,
  parseImageInput,
  textMessage,
  toolCalls,
  type ContentBlock,
  type ImageBlock,
  type ImageMediaType,
  type Message,
  type ProviderDataBlock,
  type ReasoningBlock,
  type TextBlock,
  type ToolCallBlock,
  type ToolResultBlock
} from './messages'
export { changesDiffStat, lineDiffStat, type DiffStat } from './diff-stat'
export {
  defineTool,
  ToolError,
  type AgentLanguageService,
  type AgentTool,
  type ApprovalRequest,
  type ConversationArchive,
  type ConversationInfo,
  type FileChange,
  type JsonSchema,
  type SubagentModel,
  type SubagentRequest,
  type SubagentRunner,
  type ToolContext,
  type ToolDiagnostic,
  type ToolPermission,
  type Todo,
  type TodoStatus
} from './tool'
export {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  needsApproval,
  PERMISSION_MODES,
  type PermissionMode
} from './permission'
export {
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  isAgentMode,
  modeInstructions,
  SCOPE_INSTRUCTIONS,
  toolAllowedInMode,
  type AgentMode
} from './mode'
export { ToolRegistry, validateInput, type ToolDefinition } from './registry'
export {
  addUsage,
  completeWithRetry,
  DEFAULT_RETRY_DELAYS_MS,
  describeNetworkError,
  emptyUsage,
  ProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RetryInfo,
  type StreamDelta,
  type TokenUsage
} from './provider'
export {
  fetchCatalog,
  MODELS_DEV_URL,
  parseCatalog,
  type CatalogModel,
  type CatalogProvider,
  type ProviderProtocol
} from './catalog'
export {
  AnthropicProvider,
  CodexProvider,
  createProvider,
  OpenAICompatibleProvider,
  type AnthropicProviderOptions,
  type CodexAuth,
  type CodexProviderOptions,
  type CreateProviderOptions,
  type OpenAICompatibleProviderOptions
} from './providers'
export {
  authorizationUrl,
  accessTokenExpiry,
  callbackUrl,
  CODEX_CALLBACK_PORT,
  CODEX_CLIENT_ID,
  CODEX_FALLBACK_CALLBACK_PORT,
  CODEX_ISSUER,
  CODEX_ORIGINATOR,
  CODEX_SCOPES,
  exchangeCode,
  generatePkce,
  generateState,
  needsRefresh,
  parseCallback,
  parseIdTokenClaims,
  refreshTokens,
  type AuthorizationUrlOptions,
  type CodexCallback,
  type CodexClaims,
  type CodexTokens,
  type PkceCodes
} from './codex-auth'
export {
  codexCatalogProvider,
  codexModelsUrl,
  CODEX_BASE_URL,
  CODEX_FALLBACK_MODELS,
  CODEX_PROVIDER_ID,
  parseCodexModels
} from './codex-catalog'
export { runAgent, type AgentEvent, type AgentStopReason, type RunAgentOptions, type RunAgentResult } from './loop'
export { TRIMMED_RESULT, trimToolResults, type ContextLimits, type TrimResult } from './context'
export {
  COMPACTION_SYSTEM,
  compactMessages,
  isConversationSummary,
  type CompactionOptions,
  type CompactionResult
} from './compaction'
export {
  latestProjectMemory,
  loadProjectMemory,
  MAX_PROJECT_MEMORY_CHARS,
  parseProjectInstructions,
  PROJECT_MEMORY_FILES,
  PROJECT_MEMORY_INSTRUCTIONS,
  projectMemoryText,
  projectMemoryUpdate,
  type ProjectMemory
} from './project-memory'
export {
  latestMemory,
  loadMemory,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_ENTRY_CHARS,
  MEMORY_INSTRUCTIONS,
  memoryEntries,
  memoryText,
  memoryUpdate,
  parseMemory,
  PROJECT_MEMORY_FILE,
  type MemoryScope
} from './memory'
export { forgetTool, memoryTools, rememberTool } from './tools/memory'
export {
  attachedConversationText,
  conversationLabel,
  conversationPage,
  conversationTranscript,
  CONVERSATION_PAGE_CHARS,
  MAX_ATTACHED_CONVERSATION_CHARS,
  resolveConversation,
  searchConversations,
  shortId,
  type ConversationMatch
} from './conversations'
export { conversationTools, readConversationTool, searchConversationsTool } from './tools/conversations'
export { latestTodos, MAX_TODOS, todoTool } from './tools/todo'
export {
  listModelsTool,
  resolveSubagentEffort,
  resolveSubagentModel,
  runSubagentTool,
  SUBAGENT_TOOL_NAMES,
  subagentTools
} from './tools/subagent'
export {
  coreTools,
  deleteFileTool,
  editFileTool,
  findFilesTool,
  listDirTool,
  moveFileTool,
  multiEditTool,
  readFileTool,
  searchFilesTool,
  writeFileTool
} from './tools/core'
export {
  analyzePerformanceTool,
  createCheckpointTool,
  createExampleTools,
  createJavaApiTools,
  createSkriptTools,
  dumpTypeValuesTool,
  formatScript,
  formatScriptTool,
  inspectVariablesTool,
  listCheckpointsTool,
  listCommandsTool,
  previewGuiTool,
  previewText,
  previewTextTool,
  restoreCheckpointTool,
  type TextFetcher,
  defaultExampleLoader,
  explainLineTool,
  findDefinitionTool,
  findReferencesTool,
  getDiagnosticsTool,
  getMigrationNotesTool,
  getOutlineTool,
  getProjectInfoTool,
  getServerLogTool,
  inspectPositionTool,
  renameSymbolTool,
  runServerCommandTool,
  testScriptTool,
  validateOnServerTool,
  type ExampleLoader,
  type SyntaxLoaders
} from './tools/skript'
export { SKRIPT_GUIDE } from './skript-guide'
export {
  displayGeometryTool,
  GEOMETRY_INSTRUCTIONS,
  geometryTools,
  mathEvalTool,
  SCRIPT_MARKER,
  writeDisplayLibraryTool,
  writeDisplayScriptTool
} from './tools/geometry'
export {
  attachmentText,
  conversationAttachmentText,
  conversationMention,
  conversationMentionRef,
  CONVERSATION_MENTION_PREFIX,
  CONVERSATION_REF_LENGTH,
  formatMention,
  isProblemsMention,
  parseAttachment,
  parseMentions,
  problemsAttachmentText,
  PROBLEMS_MENTIONS,
  type ProblemReport
} from './mentions'
export { listProjectFiles, readMentions, type MentionAttachments } from './attachments'
export { GOAL_INSTRUCTIONS, goalText, goalUpdate, latestGoal, parseGoal } from './goal'
export {
  EDITOR_CONTEXT_INSTRUCTIONS,
  editorContextText,
  isEditorContext,
  parseEditorContextInput,
  type EditorContext
} from './editor-context'
export {
  CACHE_NOISE_FLOOR_TOKENS,
  calculateCost,
  estimateContextTokens,
  estimateMessageTokens,
  estimateTextTokens,
  promptTokens,
  scanCacheMisses,
  type CacheMiss,
  type CacheWaste,
  type CallUsage,
  type PriceRates,
  type UsageCost
} from './usage'
