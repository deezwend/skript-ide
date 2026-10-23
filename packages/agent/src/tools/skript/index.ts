import type { AgentTool } from '../../tool'
import { createCallGraphTool } from './call-graph'
import { checkpointTools, createCheckpointTool, listCheckpointsTool, restoreCheckpointTool } from './checkpoints'
import { listCommandsTool } from './commands'
import { createExampleTools, defaultExampleLoader, type ExampleLoader } from './examples'
import { explainLineTool } from './explain-line'
import { formatScript, formatScriptTool } from './format'
import { getDiagnosticsTool } from './get-diagnostics'
import { getProjectInfoTool } from './get-project-info'
import { previewGuiTool } from './gui-preview'
import { inspectPositionTool } from './inspect-position'
import { createJavaApiTools, defaultFetcher, type TextFetcher } from './java-api'
import { createMinecraftDataTools, dumpTypeValuesTool } from './minecraft-data'
import { getMigrationNotesTool } from './migration'
import { findDefinitionTool, findReferencesTool, getOutlineTool, navigationTools, renameSymbolTool } from './navigation'
import { runServerCommandTool } from './run-on-server'
import { analyzePerformanceTool } from './performance'
import { getServerLogTool } from './server-log'
import { createSyntaxSource, createSyntaxTools, defaultSyntaxLoaders, type SyntaxLoaders } from './syntax'
import { testScriptTool } from './test-script'
import { previewText, previewTextTool } from './text-preview'
import { validateOnServerTool } from './validate-on-server'
import { inspectVariablesTool } from './variables'

export {
  analyzePerformanceTool,
  createCheckpointTool,
  createExampleTools,
  createJavaApiTools,
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
}

/** Skript'e özgü tool'lar; `ToolContext.languageService` ve `server` ile çalışır. */
export function createSkriptTools(
  loaders: SyntaxLoaders = defaultSyntaxLoaders,
  examples: ExampleLoader = defaultExampleLoader,
  fetchText: TextFetcher = defaultFetcher
): AgentTool[] {
  const projectSyntax = createSyntaxSource(loaders)
  return [
    getProjectInfoTool,
    getDiagnosticsTool,
    explainLineTool,
    inspectPositionTool,
    ...navigationTools,
    ...createSyntaxTools(loaders, projectSyntax),
    ...createExampleTools(examples),
    getMigrationNotesTool,
    inspectVariablesTool,
    createCallGraphTool(projectSyntax),
    listCommandsTool,
    analyzePerformanceTool,
    formatScriptTool,
    previewTextTool,
    previewGuiTool,
    ...createMinecraftDataTools(projectSyntax),
    ...createJavaApiTools(fetchText),
    ...checkpointTools,
    validateOnServerTool,
    testScriptTool,
    runServerCommandTool,
    getServerLogTool
  ]
}
