export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface LegendKillsRank {
  value: number
  globalPercent: string
}

export interface ApexPlayerStats {
  name: string
  uid: string
  level: number
  rankScore: number
  rankName: string
  rankDiv: number
  globalRankPercent: string
  isOnline: boolean
  selectedLegend: string
  legendKillsRank: LegendKillsRank | null
  currentState: string
  isInLobbyOrMatch: boolean
  platform: string
}

export interface PredatorPlatformInfo {
  platform: string
  requiredRp: number | null
  mastersCount: number | null
  updateTimestamp: number | null
}

export interface PredatorInfo {
  mode: string
  platforms: PredatorPlatformInfo[]
}

export interface SeasonInfo {
  seasonNumber: number | null
  seasonName: string
  startDate: string
  endDate: string
  timezone: string
  updateTimeHint: string
  source: string
  seasonUrl: string
  startIso: string
  endIso: string
}

export interface NotificationTarget {
  botSid: string
  platform: string
  selfId: string
  channelId: string
  guildId: string
}

export interface StoredPlayerRecord {
  playerName: string
  platform: string
  lookupId: string
  useUid: boolean
  rankScore: number
  rankName: string
  rankDiv: number
  lastChecked: number
  globalRankPercent: string
  selectedLegend: string
  legendKillsPercent: string
  remark?: string
}

export interface StoredGroupRecord {
  groupId: string
  target: NotificationTarget | null
  players: Record<string, StoredPlayerRecord>
}

export interface RuntimeSettings {
  runtimeBlacklist: string[]
  seasonKeywordDisabledGroups: string[]
}

export const PLATFORM_SEARCH_ORDER = ['PC', 'PS4', 'X1', 'SWITCH'] as const

export const NAME_MAP: Record<string, string> = {
  Unranked: '菜鸟',
  Bronze: '青铜',
  Silver: '白银',
  Gold: '黄金',
  Platinum: '白金',
  Diamond: '钻石',
  Master: '大师',
  'Apex Predator': 'Apex 猎杀者',
  offline: '离线',
  online: '在线',
  inLobby: '在大厅',
  'in Lobby': '在大厅',
  'In lobby': '在大厅',
  'In Lobby': '在大厅',
  inMatch: '比赛中',
  'in Match': '比赛中',
  'In match': '比赛中',
  'In Match': '比赛中',
  Offline: '离线',
  Online: '在线',
  true: '是',
  false: '否',
  Bloodhound: '寻血猎犬',
  Gibraltar: '直布罗陀',
  Lifeline: '命脉',
  Pathfinder: '探路者',
  Wraith: '恶灵',
  Bangalore: '班加罗尔',
  Caustic: '腐蚀',
  Mirage: '幻象',
  Octane: '动力小子',
  Wattson: '沃特森',
  Crypto: '密客',
  Revenant: '亡灵',
  Loba: '罗芭',
  Rampart: '兰伯特',
  Horizon: '地平线',
  Fuse: '暴雷',
  Valkyrie: '瓦尔基里',
  Seer: '希尔',
  Ash: '艾许',
  'Mad Maggie': '疯玛吉',
  Newcastle: '纽卡斯尔',
  Vantage: '万蒂奇',
  Catalyst: '卡特莉丝',
  Ballistic: '弹道',
  Conduit: '导管',
  Alter: '幻影',
  Sparrow: '麻雀',
  'BR Kills': '击杀数',
  'BR Wins': '胜场数',
  'BR Damage': '造成伤害',
  kills: '击杀数',
  wins: '胜场数',
  damage: '造成伤害',
}

export const SEASON_KEYWORD_COMMAND_BLOCKLIST = new Set([
  'apexrank',
  'apexrankwatch',
  'apexranklist',
  'apexrankremove',
  'apexpredator',
  'apexseason',
  'apextest',
  'apexhelp',
  'apex帮助',
  'apexrankhelp',
  'apexblacklist',
  'apex监控',
  'apex列表',
  'apex移除',
  'apex查询',
  '视奸',
  '持续视奸',
  '取消持续视奸',
  'apex猎杀',
  'apex赛季',
  '新赛季',
  'apex测试',
  'apex黑名单',
  '不准视奸',
  'apexban',
  '赛季关闭',
  '赛季开启',
])

export function translate(name: string) {
  return NAME_MAP[name] || name
}

export function translateState(stateText: unknown) {
  if (!stateText) return '离线'

  if (typeof stateText === 'number') {
    stateText = {
      1: 'online',
      2: 'inLobby',
      3: 'inMatch',
    }[stateText] || 'offline'
  } else {
    const text = String(stateText).trim()
    const numericState = toInt(text)
    if (numericState !== null && /^\d+$/.test(text)) {
      stateText = {
        1: 'online',
        2: 'inLobby',
        3: 'inMatch',
      }[numericState] || 'offline'
    } else {
      stateText = text
    }
  }

  let timeInfo = ''
  const text = String(stateText)
  const match = text.match(/\((\d{1,2}:\d{2})\)\s*$/)
  let body = text
  if (match) {
    timeInfo = ` (${match[1]})`
    body = text.slice(0, match.index).trim()
  }

  return `${translate(body)}${timeInfo}`
}

export function isScoreDropAbnormal(oldScore: number, newScore: number) {
  return oldScore > 1000 && newScore < 10 && newScore < oldScore
}

export function isLikelySeasonReset(oldScore: number, newScore: number) {
  return newScore < oldScore && oldScore - newScore > 1000 && newScore >= 10
}

export function normalizePlatform(platform: string) {
  const key = String(platform || '').trim().toLowerCase()
  const mapping: Record<string, string> = {
    pc: 'PC',
    ps: 'PS4',
    ps4: 'PS4',
    ps5: 'PS4',
    playstation: 'PS4',
    xbox: 'X1',
    x1: 'X1',
    switch: 'SWITCH',
    ns: 'SWITCH',
    nintendo: 'SWITCH',
  }
  return mapping[key] || String(platform || '').trim().toUpperCase()
}

export function splitCsv(raw: string, lowercase = false) {
  if (!raw) return new Set<string>()
  const items = new Set<string>()
  for (const part of String(raw).replace(/，/g, ',').split(',')) {
    const text = part.trim()
    if (!text) continue
    items.add(lowercase ? text.toLowerCase() : text)
  }
  return items
}

export function parseIdentifier(playerName: string) {
  const name = String(playerName || '').trim()
  const lowered = name.toLowerCase()
  if (lowered.startsWith('uid:')) return { identifier: name.slice(4).trim(), useUid: true }
  if (lowered.startsWith('uuid:')) return { identifier: name.slice(5).trim(), useUid: true }
  return { identifier: name, useUid: false }
}

export function normalizeLookupValue(value: string) {
  const { identifier } = parseIdentifier(value)
  return (identifier || value).trim().toLowerCase()
}

export function buildPlayerKey(lookupId: string, platform: string, useUid: boolean) {
  const prefix = useUid ? 'uid:' : 'name:'
  return `${prefix}${lookupId.trim().toLowerCase()}@${normalizePlatform(platform)}`
}

export function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  const text = String(value).trim()
  if (!text) return null
  const cleaned = text.replace(/[,，]/g, '')
  const numeric = Number(cleaned)
  if (!Number.isNaN(numeric)) return Math.trunc(numeric)
  const match = cleaned.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  return Math.trunc(Number(match[0]))
}

export function toFloat(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isNaN(numeric) ? null : numeric
}

export function coerceBool(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Boolean(value)
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
    if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  }
  return fallback
}

export function formatNow(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}/${month}/${day} ${hour}:${minute}:${second}`
}

export function normalizeKeyName(value: unknown) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function formatPlatform(platform: string) {
  const normalized = normalizePlatform(platform)
  return {
    PC: 'PC',
    PS4: 'PlayStation',
    X1: 'Xbox',
    SWITCH: 'Switch',
  }[normalized] || normalized
}

export function formatRank(rankName: string, rankDiv: number) {
  return rankDiv ? `${rankName} ${rankDiv}` : rankName
}

export function maskSecret(value: unknown) {
  const text = String(value || '')
  if (text.length <= 6) return '*'.repeat(text.length)
  return `${text.slice(0, 3)}${'*'.repeat(text.length - 6)}${text.slice(-3)}`
}

export function formatItems(items: Iterable<string>) {
  const values = Array.from(new Set(items)).filter(Boolean).sort()
  return values.length ? values.join('，') : '无'
}
