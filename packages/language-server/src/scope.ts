import type { SyntaxKind } from '@skript-ide/syntax-db'
import type { StructureKind } from './contracts'
import type { VariableAccess } from './variables'

/** Bir konumun bağlamı: içinde bulunulan yapı/olay, geçerli yerel değişkenler ve options. */

export interface ScopeSyntaxRef {
  kind: SyntaxKind
  id: string
  name: string
  addon?: string
}

export interface ScopeInfo {
  structure?: { kind: StructureKind; header: string; name?: string }
  /** Yapı bir olay gövdesiyse: başlığın eşleştiği kayıtlar ve o olayda kullanılabilen değerler. */
  event?: {
    header: string
    matches: ScopeSyntaxRef[]
    values: { name: string; description?: string }[]
  }
  variables: { name: string; local: boolean; list: boolean; access: VariableAccess }[]
  options: { name: string; value: string }[]
}
