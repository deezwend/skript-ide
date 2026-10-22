import type { AgentTool } from '../../tool'
import { deleteFileTool } from './delete-file'
import { editFileTool } from './edit-file'
import { findFilesTool } from './find-files'
import { listDirTool } from './list-dir'
import { moveFileTool } from './move-file'
import { multiEditTool } from './multi-edit'
import { readFileTool } from './read-file'
import { searchFilesTool } from './search-files'
import { writeFileTool } from './write-file'

export {
  deleteFileTool,
  editFileTool,
  findFilesTool,
  listDirTool,
  moveFileTool,
  multiEditTool,
  readFileTool,
  searchFilesTool,
  writeFileTool
}

export const coreTools: readonly AgentTool[] = [
  readFileTool,
  listDirTool,
  findFilesTool,
  searchFilesTool,
  editFileTool,
  multiEditTool,
  writeFileTool,
  moveFileTool,
  deleteFileTool
]
