import { assertExampleIndex, type ExampleIndex } from './examples'

export * from './examples'

let pending: Promise<ExampleIndex> | undefined

/**
 * Örnek indeksini yükler. Veri ayrı bir JSON parçası olarak paketlenir (syntax-db ile aynı yaklaşım);
 * paketlenmemiş Node'da `@skript-ide/corpus/node` dosya sisteminden okur.
 */
export function loadExampleIndex(): Promise<ExampleIndex> {
  if (!pending) {
    pending = import('../data/examples.json').then((module) => assertExampleIndex((module as { default: unknown }).default))
    pending.catch(() => {
      pending = undefined
    })
  }
  return pending
}
