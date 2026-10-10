import { readFileSync } from 'node:fs'
import { initRust } from '../../src/features'

await initRust(readFileSync(new URL('../pkg/adflush_features_bg.wasm', import.meta.url)))
