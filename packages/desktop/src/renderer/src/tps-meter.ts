import { estimateTextTokens } from '@skript-ide/agent/src/usage'

/** Canlı hızın hesaplandığı kayan pencere (ms). */
const WINDOW_MS = 2000
const TICK_MS = 250
/** Bu süreden kısa akışlarda kesin hız gürültülü olur; tahmin korunur. */
const MIN_EXACT_MS = 300

/**
 * Agent'ın üretim hızı (token/saniye). Akış sırasında gelen parçalardan tahmini anlık hız
 * gösterilir; çağrının kesin kullanımı gelince o çağrının ortalaması (çıktı / akış süresi) yazılır.
 */
export class TpsMeter {
  readonly element: HTMLElement
  /** Son `WINDOW_MS` içindeki parçalar: varış anı ve tahmini token sayısı. */
  private samples: { at: number; tokens: number }[] = []
  /** Mevcut model çağrısının ilk parçasının anı; çağrı yoksa `null`. */
  private streamStart: number | null = null
  private lastDelta = 0
  /** Kesin hız için önceki kullanım toplamındaki çıktı token'ları. */
  private lastOutput: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(element: HTMLElement) {
    this.element = element
    element.hidden = true
  }

  /** Tur başladı; `output` o anki kullanım toplamındaki çıktı token'larıdır (bilinmiyorsa `null`). */
  start(output: number | null): void {
    this.lastOutput = output
    this.samples = []
    this.streamStart = null
    if (this.timer === null) this.timer = setInterval(() => this.render(), TICK_MS)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.streamStart = null
    this.element.classList.remove('live')
  }

  /** Konuşma değişti: önceki hız artık anlamsız. */
  clear(): void {
    this.element.hidden = true
  }

  delta(text: string): void {
    const now = performance.now()
    this.streamStart ??= now
    this.lastDelta = now
    this.samples.push({ at: now, tokens: estimateTextTokens(text) })
  }

  /** Kullanım toplamı güncellendi; akan bir çağrı varsa kesin ortalamasını gösterir. */
  usage(output: number): void {
    const previous = this.lastOutput
    this.lastOutput = output
    if (previous === null || this.streamStart === null) return
    const elapsed = this.lastDelta - this.streamStart
    const tokens = output - previous
    if (elapsed >= MIN_EXACT_MS && tokens > 0) this.show((tokens * 1000) / elapsed, false)
    // Sonraki çağrı (tool'lardan sonra) yeni bir akış başlatır
    this.samples = []
    this.streamStart = null
  }

  private render(): void {
    const now = performance.now()
    this.samples = this.samples.filter((sample) => now - sample.at <= WINDOW_MS)
    if (this.samples.length === 0 || this.streamStart === null) {
      this.element.classList.remove('live')
      return
    }
    // Akış penceresinden kısa sürdüyse yalnızca akış süresine bölünür; ilk parçalar hızı şişirmesin diye en az bir tik
    const span = Math.max(now - Math.max(this.streamStart, now - WINDOW_MS), TICK_MS)
    const tokens = this.samples.reduce((sum, sample) => sum + sample.tokens, 0)
    this.show((tokens * 1000) / span, true)
  }

  private show(rate: number, live: boolean): void {
    this.element.hidden = false
    this.element.textContent = `${rate >= 100 ? Math.round(rate) : rate.toFixed(1)} tok/s`
    this.element.classList.toggle('live', live)
  }
}
