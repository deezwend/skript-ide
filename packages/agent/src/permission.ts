import type { ToolPermission } from './tool'

/**
 * Tool çağrılarının ne zaman onay istediği:
 * - `always-ask`: okuma dahil her tool çağrısı onay ister.
 * - `ask-when-needed`: yalnızca dosya değiştiren ya da komut çalıştıran (`write`/`exec`) tool'lar onay ister.
 * - `never-ask`: hiçbir tool onay istemez; değişiklikler doğrudan uygulanır.
 */
export type PermissionMode = 'always-ask' | 'ask-when-needed' | 'never-ask'

export const PERMISSION_MODES: readonly PermissionMode[] = ['always-ask', 'ask-when-needed', 'never-ask']

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask-when-needed'

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode)
}

export function needsApproval(mode: PermissionMode, permission: ToolPermission): boolean {
  if (mode === 'always-ask') return true
  if (mode === 'never-ask') return false
  return permission !== 'read'
}
