/**
 * Corpus örnek indeksini `data/examples.json` olarak üretir.
 *
 * Kullanım: `npm run build:examples -w @skript-ide/corpus`
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildExampleIndexFromSamples, DEFAULT_SAMPLES_DIR, EXAMPLE_DATA_PATH } from '../src/build'

const index = await buildExampleIndexFromSamples({ samplesDir: DEFAULT_SAMPLES_DIR })
await mkdir(dirname(EXAMPLE_DATA_PATH), { recursive: true })
await writeFile(EXAMPLE_DATA_PATH, `${JSON.stringify(index)}\n`, 'utf8')
const truncated = index.chunks.filter((chunk) => chunk.truncated).length
console.log(`Wrote ${index.chunks.length} chunks from ${Object.keys(index.files).length} files (${truncated} truncated) to ${EXAMPLE_DATA_PATH}`)
