import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApprovalRequest, ToolContext } from '../src/tool'

export interface TestContext extends ToolContext {
  approvals: ApprovalRequest[]
}

export function makeContext(options: {
  projectRoot?: string | null
  approve?: boolean
  signal?: AbortSignal
} = {}): TestContext {
  const approvals: ApprovalRequest[] = []
  return {
    projectRoot: options.projectRoot ?? null,
    signal: options.signal ?? new AbortController().signal,
    approvals,
    async requestApproval(request) {
      approvals.push(request)
      return options.approve ?? true
    }
  }
}

/** Geçici bir proje klasörü kurar; `files` yol → içerik. Test bitince `cleanup` çağrılmalı. */
export async function makeProject(files: Record<string, string>): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'skript-agent-'))
  const root = join(base, 'project')
  await mkdir(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return { root, cleanup: () => rm(base, { recursive: true, force: true }) }
}
