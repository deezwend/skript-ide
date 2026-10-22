export type DiagnosticSeverity = 'error' | 'warning'

export interface SkriptDiagnostic {
  /** Skript'in bildirdiği betik yolu, scripts klasörüne göre (ör. `ide\ornek.sk`). */
  file: string
  /** 1 tabanlı satır numarası. */
  line: number
  message: string
  severity: DiagnosticSeverity
  /** Hatalı satırın Skript tarafından gösterilen hali. */
  code?: string
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Paper'ın `[12:34:56 INFO]: ` öneki ve Skript'in `[Skript] ` öneki. */
const LOG_PREFIX = /^(?:\x1b\[[0-9;]*m)*\[\d{2}:\d{2}:\d{2} [A-Z]+\]: /
const SKRIPT_PREFIX = /^\[Skript\] /

const HEADER = /^Line (\d+):\s*\((.+)\)\s*$/
const LINE_DETAILS = /^Line:\s?(.*)$/

/*
 * Skript sorunları sunucu konsoluna her zaman INFO seviyesinde ve şu biçimde düşer:
 *
 *   Line 4: (ide\ornek.sk)
 *       Can't understand this expression: '5 +'
 *       Line: set {_x} to 5 +
 *
 * Hata ile uyarıyı ayıran tek şey başlığın rengi: hatalar açık kırmızı (§c),
 * uyarılar altın (§6). Paper bunları 256 renk ANSI koduna çeviriyor.
 */
const ERROR_COLOR = /\x1b\[(?:[0-9;]*;)?(?:38;5;9|91|38;2;255;85;85)m/
const WARNING_COLOR = /\x1b\[(?:[0-9;]*;)?(?:38;5;3|38;5;6|38;5;11|33|93|38;2;255;170;0)m/

function severityOf(rawHeader: string): DiagnosticSeverity {
  const beforeText = rawHeader.slice(0, rawHeader.indexOf('Line'))
  if (ERROR_COLOR.test(beforeText)) return 'error'
  if (WARNING_COLOR.test(beforeText)) return 'warning'
  return 'error'
}

interface Pending {
  file: string
  line: number
  severity: DiagnosticSeverity
  message?: string
}

/** Konsol satırlarını tek tek alır, tamamlanan her Skript sorununu `onDiagnostic` ile bildirir. */
export class SkriptLogParser {
  private pending: Pending | null = null

  constructor(private readonly onDiagnostic: (diagnostic: SkriptDiagnostic) => void) {}

  push(rawLine: string): void {
    const raw = rawLine.replace(LOG_PREFIX, '')
    const text = stripAnsi(raw).replace(SKRIPT_PREFIX, '')
    const trimmed = text.trim()

    const header = HEADER.exec(trimmed)
    if (header) {
      this.flush()
      this.pending = { file: header[2], line: Number(header[1]), severity: severityOf(raw) }
      return
    }
    if (!this.pending) return

    if (trimmed === '') {
      this.flush()
      return
    }
    const details = LINE_DETAILS.exec(trimmed)
    if (details) {
      this.flush(details[1])
      return
    }
    // İlk satır asıl mesaj; ardından gelebilen gri satır yalnızca bağlam ("from") bilgisi
    this.pending.message ??= trimmed
  }

  /** Bekleyen sorunu (varsa) tamamlar. */
  flush(code?: string): void {
    const pending = this.pending
    this.pending = null
    if (!pending?.message) return
    this.onDiagnostic({ ...pending, message: pending.message, ...(code ? { code } : {}) })
  }

  reset(): void {
    this.pending = null
  }
}
