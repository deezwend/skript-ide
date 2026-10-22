import { readFile } from 'node:fs/promises'
import { EXAMPLE_DATA_PATH } from './build'
import { assertExampleIndex, type ExampleIndex } from './examples'

export { DEFAULT_SAMPLES_DIR, EXAMPLE_DATA_PATH, buildExampleIndexFromSamples, type BuildExamplesOptions } from './build'
export * from './examples'

/** Paketlenmiş veriden örnek indeksini okur; testler ve düz Node için. */
export async function readExampleIndex(): Promise<ExampleIndex> {
  return assertExampleIndex(JSON.parse(await readFile(EXAMPLE_DATA_PATH, 'utf8')))
}
