import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  NotificationTarget,
  RuntimeSettings,
  StoredGroupRecord,
  StoredPlayerRecord,
  LoggerLike,
  ScoreHistoryEntry,
  UserBindingRecord,
  coerceBool,
  normalizePlatform,
  sanitizeRemark,
  toInt,
} from './shared'

function cloneTarget(target: NotificationTarget | null) {
  return target ? { ...target } : null
}

function defaultTarget(groupId: string): NotificationTarget {
  return {
    botSid: '',
    platform: 'onebot',
    selfId: '',
    channelId: groupId,
    guildId: groupId,
  }
}

function normalizeTarget(groupId: string, value: any): NotificationTarget | null {
  if (!value || typeof value !== 'object') return null
  const channelId = String(value.channelId ?? value.channel_id ?? value.guildId ?? value.guild_id ?? '').trim()
  if (!channelId) return null
  return {
    botSid: String(value.botSid ?? value.bot_sid ?? '').trim(),
    platform: String(value.platform ?? '').trim(),
    selfId: String(value.selfId ?? value.self_id ?? '').trim(),
    channelId,
    guildId: String(value.guildId ?? value.guild_id ?? groupId).trim() || groupId,
  }
}

function normalizePlayerRecord(value: any): StoredPlayerRecord | null {
  if (!value || typeof value !== 'object') return null
  const playerName = String(value.playerName ?? value.player_name ?? '').trim()
  if (!playerName) return null

  let legendKillsPercent = String(value.legendKillsPercent ?? value.legend_kills_percent ?? '').trim()
  if (!legendKillsPercent) {
    legendKillsPercent = String(value.legendStats?.kills?.globalPercent ?? '').trim()
  }

  const platform = normalizePlatform(String(value.platform ?? 'PC'))
  const lookupId = String(value.lookupId ?? value.lookup_id ?? playerName).trim() || playerName

  return {
    playerName,
    platform,
    lookupId,
    useUid: coerceBool(value.useUid ?? value.use_uid, false),
    rankScore: toInt(value.rankScore ?? value.rank_score) ?? 0,
    rankName: String(value.rankName ?? value.rank_name ?? '').trim() || '菜鸟',
    rankDiv: toInt(value.rankDiv ?? value.rank_div) ?? 0,
    lastChecked: toInt(value.lastChecked ?? value.last_checked) ?? 0,
    globalRankPercent: String(value.globalRankPercent ?? value.global_rank_percent ?? '未知').trim() || '未知',
    selectedLegend: String(value.selectedLegend ?? value.selected_legend ?? '').trim(),
    legendKillsPercent,
    remark: sanitizeRemark(value.remark),
  }
}

function normalizeGroupRecord(groupId: string, value: any): StoredGroupRecord | null {
  if (!value || typeof value !== 'object') return null
  const normalizedGroupId = String(value.groupId ?? value.group_id ?? groupId).trim() || groupId
  const rawPlayers = value.players && typeof value.players === 'object' ? value.players : {}
  const players: Record<string, StoredPlayerRecord> = {}

  for (const [key, player] of Object.entries(rawPlayers)) {
    const normalized = normalizePlayerRecord(player)
    if (!normalized) continue
    players[key] = normalized
  }

  const target =
    normalizeTarget(normalizedGroupId, value.target ?? value.notifyTarget) ||
    (Object.keys(players).length ? defaultTarget(normalizedGroupId) : null)

  return {
    groupId: normalizedGroupId,
    target,
    players,
  }
}

function normalizeBindingRecord(userId: string, value: any): UserBindingRecord | null {
  if (!value || typeof value !== 'object') return null
  const normalizedUserId = String(value.userId ?? value.user_id ?? userId).trim() || userId
  const lookupId = String(value.lookupId ?? value.lookup_id ?? '').trim()
  if (!normalizedUserId || !lookupId) return null
  return {
    userId: normalizedUserId,
    lookupId,
    useUid: coerceBool(value.useUid ?? value.use_uid, false),
    platform: normalizePlatform(String(value.platform ?? 'PC')),
    playerName: String(value.playerName ?? value.player_name ?? lookupId).trim() || lookupId,
    uid: String(value.uid ?? '').trim(),
    updatedAt: toInt(value.updatedAt ?? value.updated_at) ?? 0,
  }
}

function normalizeScoreHistoryEntry(value: any): ScoreHistoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const groupId = String(value.groupId ?? value.group_id ?? '').trim()
  const playerKey = String(value.playerKey ?? value.player_key ?? '').trim()
  const playerName = String(value.playerName ?? value.player_name ?? '').trim()
  if (!groupId || !playerKey || !playerName) return null
  const platform = normalizePlatform(String(value.platform ?? 'PC'))
  const oldScore = toInt(value.oldScore ?? value.old_score)
  const newScore = toInt(value.newScore ?? value.new_score)
  const delta = toInt(value.delta)
  const recordedAt = toInt(value.recordedAt ?? value.recorded_at) ?? 0
  if (oldScore === null || newScore === null || delta === null || !recordedAt) return null
  return {
    groupId,
    playerKey,
    playerName,
    remarkSnapshot: sanitizeRemark(value.remarkSnapshot ?? value.remark_snapshot) || undefined,
    displayNameSnapshot: String(value.displayNameSnapshot ?? value.display_name_snapshot ?? playerName).trim() || playerName,
    platform,
    oldScore,
    newScore,
    delta,
    recordedAt,
  }
}

async function writeJsonAtomic(filePath: string, payload: unknown) {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  const content = `${JSON.stringify(payload, null, 2)}\n`
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, filePath)
}

export class GroupStore {
  private groups: Record<string, StoredGroupRecord> = {}

  constructor(private readonly filePath: string, private readonly logger: LoggerLike) {}

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!raw || typeof raw !== 'object') return
      this.groups = {}
      for (const [groupId, value] of Object.entries(raw)) {
        const normalized = normalizeGroupRecord(groupId, value)
        if (!normalized) continue
        this.groups[groupId] = normalized
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.logger.error(`加载 groups.json 失败: ${error?.message || error}`)
      }
    }
  }

  async save() {
    const payload = Object.fromEntries(
      Object.entries(this.groups).map(([groupId, group]) => [
        groupId,
        {
          groupId: group.groupId,
          target: group.target,
          players: group.players,
        },
      ]),
    )
    await writeJsonAtomic(this.filePath, payload)
  }

  getGroup(groupId: string) {
    return this.groups[groupId]
  }

  ensureGroup(groupId: string, target?: NotificationTarget | null) {
    if (!this.groups[groupId]) {
      this.groups[groupId] = {
        groupId,
        target: target ? cloneTarget(target) : defaultTarget(groupId),
        players: {},
      }
    } else if (target) {
      this.groups[groupId].target = cloneTarget(target)
    }
    return this.groups[groupId]
  }

  updateTarget(groupId: string, target: NotificationTarget) {
    this.ensureGroup(groupId, target)
  }

  setPlayer(groupId: string, playerKey: string, record: StoredPlayerRecord, target?: NotificationTarget | null) {
    const group = this.ensureGroup(groupId, target)
    group.players[playerKey] = { ...record }
  }

  removePlayer(groupId: string, playerKey: string) {
    const group = this.groups[groupId]
    if (!group?.players[playerKey]) return false
    delete group.players[playerKey]
    if (!Object.keys(group.players).length) delete this.groups[groupId]
    return true
  }

  entries() {
    return Object.entries(this.groups)
  }
}

export class SettingsStore {
  constructor(private readonly filePath: string, private readonly logger: LoggerLike) {}

  async load(): Promise<RuntimeSettings> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!raw || typeof raw !== 'object') throw new Error('settings.json 不是对象')
      return {
        runtimeBlacklist: Array.isArray(raw.runtime_blacklist)
          ? raw.runtime_blacklist.map((item: unknown) => String(item).trim().toLowerCase()).filter(Boolean)
          : [],
        seasonKeywordDisabledGroups: Array.isArray(raw.season_keyword_disabled_groups)
          ? raw.season_keyword_disabled_groups.map((item: unknown) => String(item).trim()).filter(Boolean)
          : [],
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.logger.error(`加载 settings.json 失败: ${error?.message || error}`)
      }
      return {
        runtimeBlacklist: [],
        seasonKeywordDisabledGroups: [],
      }
    }
  }

  async save(settings: RuntimeSettings) {
    await writeJsonAtomic(this.filePath, {
      runtime_blacklist: Array.from(new Set(settings.runtimeBlacklist)).sort(),
      season_keyword_disabled_groups: Array.from(new Set(settings.seasonKeywordDisabledGroups)).sort(),
    })
  }
}

export class BindingStore {
  private bindings: Record<string, UserBindingRecord> = {}

  constructor(private readonly filePath: string, private readonly logger: LoggerLike) {}

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!raw || typeof raw !== 'object') return
      this.bindings = {}
      for (const [userId, value] of Object.entries(raw)) {
        const normalized = normalizeBindingRecord(userId, value)
        if (!normalized) continue
        this.bindings[normalized.userId] = normalized
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.logger.error(`加载 bindings.json 失败: ${error?.message || error}`)
      }
    }
  }

  async save() {
    await writeJsonAtomic(this.filePath, this.bindings)
  }

  get(userId: string) {
    return this.bindings[userId]
  }

  set(record: UserBindingRecord) {
    this.bindings[record.userId] = { ...record }
  }

  remove(userId: string) {
    if (!this.bindings[userId]) return false
    delete this.bindings[userId]
    return true
  }
}

export class ScoreHistoryStore {
  private entries: ScoreHistoryEntry[] = []

  constructor(private readonly filePath: string, private readonly logger: LoggerLike, private readonly retentionDays = 90) {}

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!Array.isArray(raw)) return
      this.entries = raw.map((value) => normalizeScoreHistoryEntry(value)).filter(Boolean) as ScoreHistoryEntry[]
      this.prune()
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.logger.error(`加载 score-history.json 失败: ${error?.message || error}`)
      }
      this.entries = []
    }
  }

  async save() {
    this.prune()
    await writeJsonAtomic(this.filePath, this.entries)
  }

  async append(entry: ScoreHistoryEntry) {
    this.entries.push({ ...entry })
    await this.save()
  }

  listByGroup(groupId: string) {
    return this.entries.filter((entry) => entry.groupId === groupId)
  }

  private prune(now = Date.now()) {
    const threshold = now - this.retentionDays * 24 * 60 * 60 * 1000
    this.entries = this.entries.filter((entry) => entry.recordedAt >= threshold)
  }
}
