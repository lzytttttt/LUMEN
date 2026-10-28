/** ids.ts —— 标识符与命名工具。 */

export function newId(prefix = 'id'): string {
  const c = globalThis.crypto as Crypto | undefined
  const raw = c?.randomUUID ? c.randomUUID() : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  return `${prefix}_${raw.replace(/-/g, '').slice(0, 12)}`
}

export function slugify(input: string, fallback = 'deck'): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? fallback : cleaned.slice(0, 60)
}

/** 稳定短哈希（用于 promptDigest 与 Mock 的确定性种子）。 */
export function shortHash(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).slice(0, 10)
}

/** 确定性伪随机（mulberry32），Mock 生成器与示例数据共用。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedFrom(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
