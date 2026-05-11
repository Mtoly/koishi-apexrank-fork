import {
  ApexPlayerStats,
  LegendKillsRank,
  LoggerLike,
  MapRotationEntry,
  MapRotationInfo,
  PLATFORM_SEARCH_ORDER,
  PredatorInfo,
  PredatorPlatformInfo,
  SeasonInfo,
  maskSecret,
  normalizeKeyName,
  normalizePlatform,
  toFloat,
  toInt,
  translate,
  translateState,
} from './shared'

export class PlayerNotFoundError extends Error {}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

function withTimeout(timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer)
    },
  }
}

export class ApexApiClient {
  static serializeDebugPayload(payload: unknown) {
    return serializePayload(sanitizeDebugPayload(payload))
  }

  constructor(
    private readonly options: {
      apiKey: string
      timeoutMs: number
      maxRetries: number
      debugLogging: boolean
      logger: LoggerLike
      fetcher?: Fetcher
    },
  ) {}

  private get fetcher() {
    return this.options.fetcher ?? fetch
  }

  async fetchPlayerStatsByName(playerName: string, platform: string) {
    const url = new URL('https://api.mozambiquehe.re/bridge')
    url.searchParams.set('auth', this.options.apiKey)
    url.searchParams.set('player', playerName)
    url.searchParams.set('platform', platform)
    const data = await this.requestPlayerData(url.toString(), playerName)
    return parsePlayerStats(data, platform, playerName)
  }

  async fetchPlayerStatsByUid(uid: string, platform: string) {
    const url = new URL('https://api.mozambiquehe.re/bridge')
    url.searchParams.set('auth', this.options.apiKey)
    url.searchParams.set('uid', uid)
    url.searchParams.set('platform', platform)
    const data = await this.requestPlayerData(url.toString(), uid)
    return parsePlayerStats(data, platform, uid)
  }

  async fetchPlayerStatsAuto(identifier: string, platform = '', useUid = false): Promise<{ player: ApexPlayerStats; platform: string }> {
    if (platform) {
      const normalized = normalizePlatform(platform)
      const player = useUid
        ? await this.fetchPlayerStatsByUid(identifier, normalized)
        : await this.fetchPlayerStatsByName(identifier, normalized)
      return { player, platform: normalized }
    }

    for (const candidate of PLATFORM_SEARCH_ORDER) {
      try {
        const player = useUid
          ? await this.fetchPlayerStatsByUid(identifier, candidate)
          : await this.fetchPlayerStatsByName(identifier, candidate)
        return { player, platform: candidate }
      } catch (error) {
        if (!(error instanceof PlayerNotFoundError)) throw error
      }
    }

    throw new PlayerNotFoundError(`Player not found: ${identifier}`)
  }

  async fetchPredatorInfo(): Promise<PredatorInfo> {
    const cacheBust = String(Date.now())
    const url = new URL('https://api.mozambiquehe.re/predator')
    url.searchParams.set('auth', this.options.apiKey)
    url.searchParams.set('_', cacheBust)
    url.searchParams.set('cb', cacheBust)
    url.searchParams.set('ts', cacheBust)

    const headers = {
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    }

    const { data: firstData, status: firstStatus } = await this.requestJson(url.toString(), headers)
    if (firstStatus === 401 || firstStatus === 403 || isInvalidApiKey(firstData)) {
      throw new Error('Invalid API key')
    }
    let [mode, payload] = selectPredatorPayload(firstData)
    let platforms = parsePredatorPlatforms(payload)

    if (platforms.length && platforms.every((entry) => entry.mastersCount === null)) {
      this.options.logger.warn('猎杀接口首次请求未解析到大师及以上人数，正在进行无缓存重试。')
      const { data: secondData, status: secondStatus } = await this.requestJson(url.toString(), headers)
      if (secondStatus === 401 || secondStatus === 403 || isInvalidApiKey(secondData)) {
        throw new Error('Invalid API key')
      }
      ;[mode, payload] = selectPredatorPayload(secondData)
      platforms = parsePredatorPlatforms(payload)
    }

    const summary = platforms
      .map((entry) => `${entry.platform}(rp=${entry.requiredRp ?? 'null'}, masters=${entry.mastersCount ?? 'null'})`)
      .join('; ')
    if (summary) this.options.logger.info(`猎杀接口解析结果: ${summary}`)

    return { mode, platforms }
  }

  async fetchMapRotationInfo(): Promise<MapRotationInfo> {
    const url = new URL('https://api.mozambiquehe.re/maprotation')
    url.searchParams.set('auth', this.options.apiKey)
    url.searchParams.set('version', '2')
    const { data, status } = await this.requestJson(url.toString())
    if (status === 401 || status === 403 || isInvalidApiKey(data)) {
      throw new Error('Invalid API key')
    }
    return parseMapRotationInfo(data)
  }

  async fetchSeasonInfo(seasonNumber?: number | null): Promise<SeasonInfo> {
    if (seasonNumber === undefined || seasonNumber === null) {
      const html = await this.requestText('https://apexlegendsstatus.com/new-season-countdown')
      return parseApexStatusCurrentSeasonInfo(html)
    }

    const homeUrl = 'https://apexseasons.online/'
    const homeHtml = await this.requestText(homeUrl)
    const references = extractSeasonReferences(homeHtml)
    const target = references.find((entry) => entry.seasonNumber === seasonNumber)
    if (!target) throw new Error(`未找到 S${seasonNumber} 的赛季数据`)
    const detailHtml = target.seasonUrl ? await this.requestText(target.seasonUrl) : ''
    const seasonInfo: SeasonInfo = {
      seasonNumber: target.seasonNumber,
      seasonName: target.seasonName,
      startDate: '未知',
      endDate: '未知',
      timezone: '未知',
      updateTimeHint: '未知',
      source: 'apexseasons.online',
      seasonUrl: target.seasonUrl,
      startIso: '',
      endIso: '',
    }
    applySeasonPageOverrides(seasonInfo, detailHtml)
    seasonInfo.statusText = seasonStatusText(seasonInfo.startIso, seasonInfo.endIso)
    if (!seasonInfo.startIso && !seasonInfo.endIso) {
      const fallback = parseCurrentSeason(homeHtml)
      if (fallback.seasonNumber === seasonNumber) return fallback
    }
    return seasonInfo
  }

  async fetchCurrentSeasonInfo(): Promise<SeasonInfo> {
    const homeUrl = 'https://apexseasons.online/'
    const homeHtml = await this.requestText(homeUrl)
    const seasonInfo = parseCurrentSeason(homeHtml)

    if (seasonInfo.seasonUrl) {
      try {
        const detailHtml = await this.requestText(seasonInfo.seasonUrl)
        applySeasonPageOverrides(seasonInfo, detailHtml)
        seasonInfo.statusText = seasonStatusText(seasonInfo.startIso, seasonInfo.endIso)
      } catch (error: any) {
        this.options.logger.warn(`获取赛季详情页失败: ${error?.message || error}`)
      }
    }

    return seasonInfo
  }

  private async requestPlayerData(url: string, identifier: string) {
    const { data, status } = await this.requestJson(url)
    if (status === 401 || isInvalidApiKey(data)) {
      throw new Error('Invalid API key')
    }
    if (status === 400 || status === 404 || isPlayerNotFound(data)) {
      throw new PlayerNotFoundError(`Player not found: ${identifier}`)
    }
    return data
  }

  private async requestJson(url: string, extraHeaders?: HeadersInit) {
    let lastError: unknown

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = retryDelay(attempt)
        this.options.logger.info(`API 请求失败，正在重试 ${attempt}/${this.options.maxRetries}，延迟 ${delay}s...`)
        await new Promise((resolve) => setTimeout(resolve, delay * 1000))
      }

      const timeout = withTimeout(this.options.timeoutMs)
      try {
        const headers: HeadersInit = {
          'User-Agent': 'Koishi-ApexRankWatch/2.0.0',
          ...(extraHeaders || {}),
        }
        this.debugLogRequest('JSON', url, headers)
        const response = await this.fetcher(url, { method: 'GET', headers, signal: timeout.signal })
        const text = await response.text()
        const data = parseJsonLike(text)
        this.debugLogResponse('JSON', url, data, response.status)

        if (response.status === 429 || response.status >= 500) {
          throw new Error(`retryable:${response.status}`)
        }

        return { data, status: response.status }
      } catch (error: any) {
        lastError = error
        this.debugLogError('JSON', url, error)
        if (String(error?.message || '').startsWith('retryable:') && attempt < this.options.maxRetries) continue
        if (error?.name === 'AbortError' && attempt < this.options.maxRetries) continue
        if (error?.message?.includes('fetch failed') && attempt < this.options.maxRetries) continue
        if (error?.message?.includes('retryable:')) throw new Error(`Apex API 请求失败 (${error.message.replace('retryable:', 'HTTP ')})`)
        throw error
      } finally {
        timeout.clear()
      }
    }

    throw lastError
  }

  private async requestText(url: string) {
    let lastError: unknown

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = retryDelay(attempt)
        this.options.logger.info(`页面请求失败，正在重试 ${attempt}/${this.options.maxRetries}，延迟 ${delay}s...`)
        await new Promise((resolve) => setTimeout(resolve, delay * 1000))
      }

      const timeout = withTimeout(this.options.timeoutMs)
      try {
        const headers: HeadersInit = {
          'User-Agent': 'Koishi-ApexRankWatch/2.0.0',
        }
        this.debugLogRequest('TEXT', url, headers)
        const response = await this.fetcher(url, { method: 'GET', headers, signal: timeout.signal })
        const text = await response.text()
        this.debugLogResponse('TEXT', url, text, response.status)
        if (response.status === 429 || response.status >= 500) throw new Error(`retryable:${response.status}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return text
      } catch (error: any) {
        lastError = error
        this.debugLogError('TEXT', url, error)
        if ((String(error?.message || '').startsWith('retryable:') || error?.name === 'AbortError') && attempt < this.options.maxRetries) continue
        throw error
      } finally {
        timeout.clear()
      }
    }

    throw lastError
  }

  private debugLogRequest(kind: string, url: string, headers?: HeadersInit) {
    if (!this.options.debugLogging) return
    this.options.logger.info(`[DEBUG] ${kind} 请求 => url=${url}, headers=${serializeHeaders(headers)}`)
  }

  private debugLogResponse(kind: string, url: string, payload: unknown, status: number) {
    if (!this.options.debugLogging) return
    const preview = ApexApiClient.serializeDebugPayload(payload)
    this.options.logger.info(`[DEBUG] ${kind} 响应 <= url=${url}, status=${status}, payload=${preview}`)
  }

  private debugLogError(kind: string, url: string, error: unknown) {
    if (!this.options.debugLogging) return
    this.options.logger.error(`[DEBUG] ${kind} 异常 !! url=${url}, error=${String((error as any)?.message || error)}`)
  }
}

function serializeHeaders(headers?: HeadersInit) {
  if (!headers) return '{}'
  const entries = Array.isArray(headers)
    ? headers
    : headers instanceof Headers
      ? Array.from(headers.entries())
      : Object.entries(headers)
  const sanitized = Object.fromEntries(entries.map(([key, value]) => [key, /auth|token|api[-_]?key|authorization/i.test(key) ? maskSecret(value) : value]))
  return JSON.stringify(sanitized)
}

function serializePayload(payload: unknown) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return text.length > 4000 ? `${text.slice(0, 4000)}...(truncated)` : text
}

function sanitizeDebugPayload(payload: unknown, key = ''): unknown {
  if (payload === null || payload === undefined) return payload
  const normalizedKey = normalizeKeyName(key)
  if (['auth', 'authorization', 'apikey', 'api_key', 'token', 'secret', 'password', 'cookie'].some((candidate) => normalizedKey.includes(normalizeKeyName(candidate)))) {
    return maskSecret(payload)
  }
  if (['uid', 'uuid', 'userid', 'groupid', 'player', 'playername', 'name', 'displayname'].includes(normalizedKey)) {
    return '***'
  }
  if (Array.isArray(payload)) return payload.map((item) => sanitizeDebugPayload(item, key))
  if (typeof payload === 'object') {
    return Object.fromEntries(Object.entries(payload).map(([nestedKey, value]) => [nestedKey, sanitizeDebugPayload(value, nestedKey)]))
  }
  if (typeof payload === 'string') {
    return payload
      .replace(/(auth|api[_-]?key|token)=([^&\s]+)/gi, '$1=***')
      .replace(/(player|uid|uuid|name)=([^&\s]+)/gi, '$1=***')
  }
  return payload
}

function retryDelay(attempt: number) {
  return Math.min(5, Math.max(1, 2 ** (attempt - 1)))
}

function isPlayerNotFound(data: any) {
  if (!data || typeof data !== 'object') return true
  for (const key of ['Error', 'error', 'message']) {
    const value = data[key]
    if (typeof value === 'string' && value.toLowerCase().includes('not found')) return true
  }
  const globalData = data.global
  if (!globalData || typeof globalData !== 'object') return true
  return !globalData.name && !globalData.uid
}

function isInvalidApiKey(data: any) {
  if (!data) return false
  if (typeof data === 'string') {
    const text = data.toLowerCase()
    return text.includes('invalid api key') || text.includes(`api key doesn't exist`)
  }
  if (typeof data === 'object') {
    for (const key of ['Error', 'error', 'message']) {
      const value = data[key]
      if (typeof value === 'string' && (value.toLowerCase().includes('invalid api key') || value.toLowerCase().includes(`api key doesn't exist`))) {
        return true
      }
    }
  }
  return false
}

function parseJsonLike(text: string) {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed) return null
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return JSON.parse(trimmed)
  }
  return trimmed
}

function parsePlayerStats(data: any, platform: string, fallbackName: string): ApexPlayerStats {
  const globalData = data?.global ?? {}
  const realtimeData = data?.realtime ?? {}
  const rankData = globalData?.rank ?? {}
  const legendsData = data?.legends ?? {}

  const selectedLegendRaw = String(realtimeData.selectedLegend ?? '')
  const selectedLegend = translate(selectedLegendRaw)

  let legendKillsRank: LegendKillsRank | null = null
  const legendStatsData = Array.isArray(legendsData?.selected?.data) ? legendsData.selected.data : []
  for (const stat of legendStatsData) {
    if (!stat || typeof stat !== 'object') continue
    if (stat.name !== 'BR Kills' && stat.key !== 'specialEvent_kills') continue
    const topPercent = toFloat(stat.rank?.topPercent)
    if (topPercent === null) continue
    legendKillsRank = {
      value: toInt(stat.value) ?? 0,
      globalPercent: topPercent.toFixed(2),
    }
    break
  }

  const currentStateRaw = realtimeData.currentStateAsText ?? realtimeData.currentState ?? 'offline'
  const currentState = translateState(currentStateRaw)
  const isOnline = (toInt(realtimeData.isOnline) ?? 0) === 1 || realtimeData.isOnline === true

  return {
    name: String(globalData.name || fallbackName),
    uid: String(globalData.uid || ''),
    level: toInt(globalData.level) ?? 0,
    rankScore: toInt(rankData.rankScore) ?? 0,
    rankName: translate(String(rankData.rankName ?? 'Unranked')),
    rankDiv: toInt(rankData.rankDiv) ?? 0,
    globalRankPercent: rankData.ALStopPercentGlobal === undefined || rankData.ALStopPercentGlobal === null || rankData.ALStopPercentGlobal === ''
      ? '未知'
      : String(rankData.ALStopPercentGlobal),
    isOnline,
    selectedLegend,
    legendKillsRank,
    currentState,
    isInLobbyOrMatch: currentState.includes('大厅') || currentState.includes('比赛'),
    platform,
  }
}

function selectPredatorPayload(data: any): [string, Record<string, any>] {
  if (data && typeof data === 'object') {
    for (const key of ['RP', 'AP']) {
      if (data[key] && typeof data[key] === 'object') return [key, data[key]]
    }
    return ['RP', data]
  }
  return ['RP', {}]
}

function parsePredatorPlatforms(payload: Record<string, any>): PredatorPlatformInfo[] {
  if (!payload || typeof payload !== 'object') return []
  const keys = Array.from(new Set([...PLATFORM_SEARCH_ORDER, ...Object.keys(payload)]))
  const result: PredatorPlatformInfo[] = []
  for (const key of keys) {
    const entry = payload[key]
    if (!entry || typeof entry !== 'object') continue
    result.push({
      platform: key,
      requiredRp: getFirstInt(entry, 'val', 'value', 'rp', 'RP', 'requiredRP', 'required_rp', 'score'),
      mastersCount: getFirstInt(entry, 'count', 'totalMastersAndPreds', 'totalMasters', 'masters', 'mastersCount', 'masterCount', 'totalMasterCount'),
      updateTimestamp: getFirstInt(entry, 'updateTimestamp', 'lastUpdated', 'updateTime', 'updatedAt', 'timestamp'),
    })
  }
  return result
}

function parseMapRotationInfo(data: any): MapRotationInfo {
  return {
    ranked: parseMapRotationMode(data?.ranked),
    battleRoyale: parseMapRotationMode(data?.battle_royale ?? data?.battleRoyale ?? data?.battle_royale_pub),
  }
}

function parseMapRotationMode(data: any) {
  return {
    current: parseMapRotationEntry(data?.current),
    next: parseMapRotationEntry(data?.next),
  }
}

function parseMapRotationEntry(data: any): MapRotationEntry | null {
  if (!data || typeof data !== 'object') return null
  const mapName = String(data.map ?? data.mapName ?? data.name ?? '').trim()
  if (!mapName) return null
  return {
    start: toInt(data.start ?? data.startTimestamp ?? data.start_time),
    end: toInt(data.end ?? data.endTimestamp ?? data.end_time),
    mapName,
    mapNameZh: translate(mapName),
    remainingTimer: String(data.remainingTimer ?? data.remaining_timer ?? '').trim(),
  }
}

function getFirstInt(data: any, ...candidates: string[]) {
  if (!data || typeof data !== 'object') return null
  for (const candidate of candidates) {
    const value = toInt(data[candidate])
    if (value !== null) return value
  }
  const normalized = new Set(candidates.map((candidate) => normalizeKeyName(candidate)))
  return findFirstIntByCandidates(data, normalized)
}

function findFirstIntByCandidates(value: any, normalizedCandidates: Set<string>): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const numeric = findFirstIntByCandidates(item, normalizedCandidates)
      if (numeric !== null) return numeric
    }
    return null
  }

  if (!value || typeof value !== 'object') return null
  for (const [key, nested] of Object.entries(value)) {
    if (normalizedCandidates.has(normalizeKeyName(key))) {
      const numeric = toInt(nested)
      if (numeric !== null) return numeric
    }
  }
  for (const nested of Object.values(value)) {
    const numeric = findFirstIntByCandidates(nested, normalizedCandidates)
    if (numeric !== null) return numeric
  }
  return null
}

type SeasonReference = {
  seasonNumber: number
  seasonName: string
  seasonUrl: string
}

function extractSeasonReferences(html: string): SeasonReference[] {
  const blocks = Array.from(html.matchAll(/<script\s+type="application\/ld\+json">(.*?)<\/script>/gis)).map((match) => match[1])
  const references: SeasonReference[] = []
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    let parsed: any
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of candidates) {
      const elements = Array.isArray(item?.itemListElement) ? item.itemListElement : []
      for (const element of elements) {
        const [seasonNumber, seasonName] = parseSeasonName(String(element?.name ?? ''))
        if (seasonNumber === null) continue
        references.push({
          seasonNumber,
          seasonName,
          seasonUrl: String(element?.url ?? ''),
        })
      }
    }
  }
  return references
}

function parseApexStatusCurrentSeasonInfo(html: string, now = new Date()): SeasonInfo {
  const [seasonNumber, seasonName] = extractApexStatusSeasonTitle(html)
  const startTimestamp = extractApexStatusStartTimestamp(html)
  const start = startTimestamp ? new Date(startTimestamp * 1000) : null
  const end = start ? new Date(start.getTime() + 91 * 24 * 60 * 60 * 1000) : null

  const startIso = start ? toIso(start) : ''
  const endIso = end ? toIso(end) : ''

  return {
    seasonNumber,
    seasonName,
    startDate: start ? formatBeijingDate(start) : '未知',
    endDate: end ? formatBeijingDate(end) : '未知',
    timezone: 'Asia/Shanghai',
    updateTimeHint: '',
    source: 'apexlegendsstatus.com',
    seasonUrl: 'https://apexlegendsstatus.com/new-season-countdown',
    startIso,
    endIso,
    statusText: seasonStatusText(startIso, endIso, now),
  }
}

function extractApexStatusSeasonTitle(html: string): [number | null, string] {
  const titleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<title[^>]*>(.*?)<\/title>/is)
    || html.match(/Countdown to Season\s+\d+[^<\n]*/i)
  const title = String(titleMatch?.[1] ?? titleMatch?.[0] ?? '')
  const match = title.match(/Season\s+(\d+)(?::|\s+[·•-])?\s*([^<"]*)/i)
  if (!match) return [null, '']
  return [toInt(match[1]), match[2].replace(/^[-:·•\s]+/, '').trim()]
}

function extractApexStatusStartTimestamp(html: string) {
  const match =
    html.match(/\bstartTime\s*=\s*(\d{10})\b/i)
    || html.match(/"startTime"\s*:\s*(\d{10})/i)
  return toInt(match?.[1])
}

function toIso(date: Date) {
  return date.toISOString().replace('.000Z', 'Z')
}

function formatBeijingDate(date: Date) {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())} 北京时间`
}

function seasonStatusText(startIso: string, endIso: string, now = new Date()) {
  const start = new Date(startIso).getTime()
  const end = new Date(endIso).getTime()
  const current = now.getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '未知'
  if (current < start) return '未开始'
  if (current > end) return '已结束'
  return '进行中'
}

function parseCurrentSeason(html: string): SeasonInfo {
  let seasonNumber: number | null = null
  let seasonName = ''
  let startDate = '未知'
  let endDate = '未知'
  let timezone = '未知'
  let updateTimeHint = '未知'
  let seasonUrl = ''
  let startIso = ''
  let endIso = ''

  if (html) {
    const jsonldBlocks = Array.from(html.matchAll(/<script\s+type="application\/ld\+json">(.*?)<\/script>/gis)).map((match) => match[1])
    ;[seasonNumber, seasonName, seasonUrl] = extractSeasonFromJsonLd(jsonldBlocks)

    if (seasonNumber === null || !seasonName) {
      const match = html.match(/Season\s+(\d+)\s+[·•路-]\s+([^\n]+?)\s+(?:is live now|Started)/i)
      if (match) {
        seasonNumber = toInt(match[1])
        seasonName = match[2].trim()
      }
    }

    endIso = extractCountdownTarget(html) || ''
    if (endIso) endDate = formatIsoDate(endIso)

    const dateMatch = html.match(/Started\s+([A-Za-z]{3}\s+\d{1,2})\s+(\d{4})\s+Ends\s+([A-Za-z]{3}\s+\d{1,2})\s+(\d{4})/is)
    if (dateMatch) {
      startDate = `${dateMatch[1]} ${dateMatch[2]}`
      endDate = `${dateMatch[3]} ${dateMatch[4]}`
    }

    const timezoneMatch = html.match(/Timezone\s+[·•路-]\s+([^\n]+)/i)
    if (timezoneMatch) timezone = cleanTimezone(timezoneMatch[1])

    const updateMatch = html.match(/Respawn\s+deploys\s+all\s+major\s+updates\s+at\s+([^\n.]+)/i)
    if (updateMatch) updateTimeHint = updateMatch[1].trim()
  }

  return {
    seasonNumber,
    seasonName,
    startDate,
    endDate,
    timezone,
    updateTimeHint,
    source: 'apexseasons.online',
    seasonUrl,
    startIso,
    endIso,
    statusText: seasonStatusText(startIso, endIso),
  }
}

function extractSeasonFromJsonLd(blocks: string[]): [number | null, string, string] {
  let bestNumber: number | null = null
  let bestName = ''
  let bestUrl = ''
  let bestPosition: number | null = null

  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    let parsed: any
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const candidates = Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [parsed]
    for (const item of candidates) {
      if (item?.['@type'] !== 'ItemList') continue
      const elements = Array.isArray(item.itemListElement) ? item.itemListElement : []
      for (const element of elements) {
        if (!element || typeof element !== 'object') continue
        const [number, title] = parseSeasonName(String(element.name ?? ''))
        if (number === null) continue
        const position = toInt(element.position)
        if (bestPosition === null || (position !== null && position < bestPosition)) {
          bestPosition = position
          bestNumber = number
          bestName = title
          bestUrl = String(element.url ?? '')
        }
      }
    }
  }

  return [bestNumber, bestName, bestUrl]
}

function parseSeasonName(text: string): [number | null, string] {
  const match = text.match(/Season\s+(\d+)\s+[·•路-]\s+(.+)/i)
  if (!match) return [null, '']
  return [toInt(match[1]), match[2].trim()]
}

function applySeasonPageOverrides(seasonInfo: SeasonInfo, html: string) {
  if (!html) return
  const [startIso, endIso] = extractEventDatesFromJsonLd(html)
  if (startIso) {
    seasonInfo.startIso = startIso
    seasonInfo.startDate = formatIsoDate(startIso)
  }
  if (endIso) {
    seasonInfo.endIso = endIso
    seasonInfo.endDate = formatIsoDate(endIso)
  }

  const start = extractDate(html, 'Start Date')
  const end = extractDate(html, 'End Date')
  if (start) seasonInfo.startDate = start
  if (end) seasonInfo.endDate = end

  if (seasonInfo.startDate === '未知' || seasonInfo.endDate === '未知') {
    const match = html.match(/Started\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}).*?Ends\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/is)
    if (match) {
      seasonInfo.startDate = match[1].trim()
      seasonInfo.endDate = match[2].trim()
    }
  }

  const timezoneMatch = html.match(/Timezone\s*:?\s*([^\n<]+)/i)
  if (timezoneMatch) {
    seasonInfo.timezone = cleanTimezone(timezoneMatch[1])
  } else if (startIso?.endsWith('Z')) {
    seasonInfo.timezone = 'UTC'
  }
}

function extractEventDatesFromJsonLd(html: string): [string | null, string | null] {
  const blocks = Array.from(html.matchAll(/<script\s+type="application\/ld\+json">(.*?)<\/script>/gis)).map((match) => match[1])
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    let parsed: any
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const items = Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [parsed]
    for (const item of items) {
      if (item?.['@type'] === 'Event') {
        return [String(item.startDate ?? '') || null, String(item.endDate ?? '') || null]
      }
    }
  }
  return [null, null]
}

function formatIsoDate(value: string) {
  try {
    const iso = value.endsWith('Z') ? value.replace('Z', '+00:00') : value
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return value
    return date.toISOString().replace('T', ' ').slice(0, 16)
  } catch {
    return value
  }
}

function cleanTimezone(value: string) {
  return value.replace(/<!-- -->/g, ' ').replace(/^[·•路-]/, '').replace(/\s+/g, ' ').trim() || '未知'
}

function extractCountdownTarget(html: string) {
  const arrayMatch = html.match(/targetDate"\s*:\s*\[0\s*,\s*"([^"]+)"\]/i)
  if (arrayMatch) return arrayMatch[1].trim()
  const plainMatch = html.match(/targetDate"\s*:\s*"([^"]+)"/i)
  return plainMatch?.[1].trim() || null
}

function extractDate(html: string, label: string) {
  const safeLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(new RegExp(`${safeLabel}\\s*:?\\s*([A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})`, 'i'))
  return match?.[1].trim() || null
}
