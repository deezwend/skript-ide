/**
 * `@skript-ide/agent`: IDE'nin AI agent çekirdeği. Electron'dan ve LLM sağlayıcısından bağımsızdır;
 * masaüstü uygulaması bunu ana süreçte çalıştırır, sağlayıcıyı `ModelProvider` ile verir.
 */
export {
  textMessage,
  toolCalls,
  type ContentBlock,
  type Message,
  type TextBlock,
  type ToolCallBlock,
  type ToolResultBlock
} from './messages'
export {
  defineTool,
  ToolError,
  type AgentTool,
  type ApprovalRequest,
  type JsonSchema,
  type ToolContext,
  type ToolPermission
} from './tool'
export { ToolRegistry, validateInput, type ToolDefinition } from './registry'
export type { ModelProvider, ModelRequest, ModelResponse } from './provider'
export { runAgent, type AgentEvent, type AgentStopReason, type RunAgentOptions, type RunAgentResult } from './loop'
export { coreTools, editFileTool, listDirTool, readFileTool, searchFilesTool } from './tools/core'
