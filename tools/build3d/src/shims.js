// Node globals some prismarine/minecraft-data code expects in the browser.
import { Buffer } from 'buffer'
export { Buffer }
export const process = { env: {}, platform: 'browser', browser: true, version: '', versions: {}, nextTick: (fn, ...a) => Promise.resolve().then(() => fn(...a)) }
