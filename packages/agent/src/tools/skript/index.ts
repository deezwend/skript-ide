import type { AgentTool } from '../../tool'
import { createExampleTools, defaultExampleLoader, type ExampleLoader } from './examples'
import { explainLineTool } from './explain-line'
import { getDiagnosticsTool } from './get-diagnostics'
import { getProjectInfoTool } from './get-project-info'
import { inspectPositionTool } from './inspect-position'
import { getMigrationNotesTool } from './migration'
import { findDefinitionTool, findReferencesTool, getOutlineTool, navigationTools, renameSymbolTool } from './navigation'
import { runServerCommandTool } from './run-on-server'
import { getServerLogTool } from './server-log'
import { createSyntaxTools, defaultSyntaxLoaders, type SyntaxLoaders } from './syntax'
import { testScriptTool } from './test-script'
import { validateOnServerTool } from './validate-on-server'

export {
  createExampleTools,
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
  examples: ExampleLoader = defaultExampleLoader
): AgentTool[] {
  return [
    getProjectInfoTool,
    getDiagnosticsTool,
    explainLineTool,
    inspectPositionTool,
    ...navigationTools,
    ...createSyntaxTools(loaders),
    ...createExampleTools(examples),
    getMigrationNotesTool,
    validateOnServerTool,
    testScriptTool,
    runServerCommandTool,
    getServerLogTool
  ]
}
