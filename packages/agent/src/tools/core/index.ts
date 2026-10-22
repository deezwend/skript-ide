import type { AgentTool } from '../../tool'
import { editFileTool } from './edit-file'
import { listDirTool } from './list-dir'
import { readFileTool } from './read-file'
import { searchFilesTool } from './search-files'

export { editFileTool, listDirTool, readFileTool, searchFilesTool }

export const coreTools: readonly AgentTool[] = [readFileTool, listDirTool, searchFilesTool, editFileTool]
