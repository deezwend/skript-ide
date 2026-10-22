import type { AgentTool } from '../../tool'
import { getDiagnosticsTool } from './get-diagnostics'
import { getProjectInfoTool } from './get-project-info'
import { createSyntaxTools, defaultSyntaxLoaders, type SyntaxLoaders } from './syntax'
import { validateOnServerTool } from './validate-on-server'

export { getDiagnosticsTool, getProjectInfoTool, validateOnServerTool, type SyntaxLoaders }

/** Skript'e özgü tool'lar; `ToolContext.languageService` ve `server` ile çalışır. */
export function createSkriptTools(loaders: SyntaxLoaders = defaultSyntaxLoaders): AgentTool[] {
  return [getProjectInfoTool, getDiagnosticsTool, ...createSyntaxTools(loaders), validateOnServerTool]
}
