import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LeaderboardAvatarCacheOptions, AvatarCacheEntry } from './resource-types'

function cacheFilePath(cacheDir: string, sourceUrl: string) {
  const hash = createHash('md5').update(sourceUrl).digest('hex')
  return join(cacheDir, `${hash}.json`)
}

export class LeaderboardAvatarCache {
  private readonly memoryCache = new Map<string, AvatarCacheEntry>()

  constructor(private readonly options: LeaderboardAvatarCacheOptions) {}

  async get(sourceUrl: string) {
    if (!sourceUrl) return null
    const now = Date.now()
    const memoryEntry = this.memoryCache.get(sourceUrl)
    if (memoryEntry && !this.isExpired(memoryEntry, now)) return memoryEntry

    const filePath = cacheFilePath(this.options.cacheDir, sourceUrl)
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as AvatarCacheEntry
      if (!this.isExpired(raw, now)) {
        this.memoryCache.set(sourceUrl, raw)
        return raw
      }
    } catch {}
    return null
  }

  async set(entry: AvatarCacheEntry) {
    const filePath = cacheFilePath(this.options.cacheDir, entry.sourceUrl)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    this.memoryCache.set(entry.sourceUrl, entry)
  }

  clearMemory() {
    this.memoryCache.clear()
  }

  private isExpired(entry: AvatarCacheEntry, now: number) {
    const ttl = entry.status === 'fallback' ? this.options.failureTtlMs : this.options.successTtlMs
    if (ttl <= 0) return false
    return now - entry.timestamp >= ttl
  }
}
