import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bot, Context, Logger, Session, h, type Fragment } from 'koishi'
import { ApexApiClient, PlayerNotFoundError } from './api'
import { ResolvedConfig } from './config'
import { ApexImageRenderer } from './image'
import { renderLeaderboardOutput } from './leaderboard/render'
import { getLeaderboardResourceLayout } from './leaderboard/resource-reloader'
import type { LeaderboardRenderRequest } from './leaderboard/types'
import { BindingStore, GroupStore, ScoreHistoryStore, SettingsStore } from './storage'
import {
  ApexPlayerStats,
  LeaderboardEntry,
  MapRotationInfo,
  NotificationTarget,
  RuntimeSettings,
  ScoreHistoryEntry,
  SEASON_KEYWORD_COMMAND_BLOCKLIST,
  StoredGroupRecord,
  StoredPlayerRecord,
  UserBindingRecord,
  buildPlayerKey,
  formatItems,
  formatLookupIdentifier,
  formatNow,
  formatPlatform,
  formatPlayerDisplayName,
  formatRank,
  getBeijingLeaderboardRange,
  isLikelySeasonReset,
  isScoreDropAbnormal,
  isTimestampInRange,
  normalizeLookupValue,
  normalizePlatform,
  parseIdentifier,
  sanitizeRemark,
  splitCsv,
  summarizeLeaderboard,
} from './shared'

type CommandSession = Session

export class ApexRankWatchRuntime {
  private readonly logger = new Logger('apexrankwatch')
  private readonly dataDir: string
  private readonly groupsFile: string
  private readonly settingsFile: string
  private readonly bindingsFile: string
  private readonly scoreHistoryFile: string
  private readonly groupStore: GroupStore
  private readonly settingsStore: SettingsStore
  private readonly bindingStore: BindingStore
  private readonly scoreHistoryStore: ScoreHistoryStore
  private readonly imageRenderer: ApexImageRenderer
  private readonly api: ApexApiClient
  private readonly configBlacklist: Set<string>
  private readonly queryBlocklist: Set<string>
  private readonly userBlacklist: Set<string>
  private readonly ownerSet: Set<string>
  private readonly whitelistGroups: Set<string>
  private readonly ready: Promise<void>
  private settings: RuntimeSettings = {
    runtimeBlacklist: [],
    seasonKeywordDisabledGroups: [],
  }

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {
    this.dataDir = resolve(process.cwd(), this.config.dataDir)
    this.groupsFile = resolve(this.dataDir, 'groups.json')
    this.settingsFile = resolve(this.dataDir, 'settings.json')
    this.bindingsFile = resolve(this.dataDir, 'bindings.json')
    this.scoreHistoryFile = resolve(this.dataDir, 'score-history.json')
    this.groupStore = new GroupStore(this.groupsFile, this.logger)
    this.settingsStore = new SettingsStore(this.settingsFile, this.logger)
    this.bindingStore = new BindingStore(this.bindingsFile, this.logger)
    this.scoreHistoryStore = new ScoreHistoryStore(this.scoreHistoryFile, this.logger)
    this.imageRenderer = new ApexImageRenderer(this.dataDir)
    this.api = new ApexApiClient({
      apiKey: this.config.apiKey,
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      debugLogging: this.config.debugLogging,
      logger: this.logger,
    })
    this.configBlacklist = splitCsv(this.config.blacklist, true)
    this.queryBlocklist = splitCsv(this.config.queryBlocklist, true)
    this.userBlacklist = splitCsv(this.config.userBlacklist, false)
    this.ownerSet = splitCsv(this.config.ownerQq, false)
    this.whitelistGroups = splitCsv(this.config.whitelistGroups, false)
    this.registerCommands()
    this.registerSeasonKeywordMiddleware()
    this.ready = this.waitForKoishiReady()
  }

  private waitForKoishiReady() {
    let started = false
    return new Promise<void>((resolve, reject) => {
      this.ctx.on('ready', () => {
        if (started) return
        started = true
        void this.initialize().then(resolve, reject)
      })
    })
  }

  private async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    await this.groupStore.load()
    this.settings = await this.settingsStore.load()
    await this.bindingStore.load()
    await this.scoreHistoryStore.load()
    await this.migrateStoreKeys()

    this.ctx.setInterval(() => {
      void this.pollOnce().catch((error) => {
        this.logger.error(`poll task failed: ${String((error as Error)?.message || error)}`)
      })
    }, this.config.checkInterval * 60_000)

    void this.pollOnce().catch((error) => {
      this.logger.error(`initial poll failed: ${String((error as Error)?.message || error)}`)
    })

    this.logger.info(`Apex Rank Watch loaded, interval ${this.config.checkInterval} minute(s)`)
    if (!this.config.apiKey) {
      this.logger.warn('Apex API Key is missing, so player query, watch, and predator features are disabled.')
    }
    if (this.config.debugLogging) {
      this.logger.info('Apex Rank Watch debug logging is enabled.')
    }
  }

  private registerCommands() {
    this.ctx.command('apextest', 'test plugin health')
      .alias('apex\u6d4b\u8bd5')
      .action(this.wrap(async (session) => this.handleTest(session)))

    this.ctx.command('apexhelp', 'show plugin help')
      .alias('apex\u5e2e\u52a9')
      .alias('apexrankhelp')
      .action(this.wrap(async (session) => this.handleHelp(session)))

    this.ctx.command('apexrank [input:text]', 'query current rank')
      .alias('apex\u67e5\u8be2')
      .alias('\u89c6\u5978')
      .action(this.wrap(async (session, input = '') => this.handleRankQuery(session, input)))

    this.ctx.command('apex\u67e5\u5206 [input:text]', 'query bound account or specified player rank')
      .action(this.wrap(async (session, input = '') => this.handleBoundRankQuery(session, input)))

    this.ctx.command('apex\u7ed1\u5b9a [input:text]', 'bind a default apex account for the current user')
      .action(this.wrap(async (session, input = '') => this.handleBind(session, input)))

    this.ctx.command('apex\u89e3\u7ed1', 'unbind the current user apex account')
      .action(this.wrap(async (session) => this.handleUnbind(session)))

    this.ctx.command('apex\u6211\u7684\u8d26\u53f7', 'show the bound apex account for the current user')
      .alias('apex\u7ed1\u5b9a\u4fe1\u606f')
      .action(this.wrap(async (session) => this.handleBindingInfo(session)))

    this.ctx.command('apexrankwatch [input:text]', 'watch player rank in current group')
      .alias('apex\u76d1\u63a7')
      .alias('\u6301\u7eed\u89c6\u5978')
      .action(this.wrap(async (session, input = '') => this.handleWatch(session, input)))

    this.ctx.command('apexranklist', 'show watch list')
      .alias('apex\u5217\u8868')
      .action(this.wrap(async (session) => this.handleList(session)))

    this.ctx.command('apexremark <player> [platformOrRemark:text]', 'set a remark for a watched player')
      .alias('apex\u5907\u6ce8')
      .action(this.wrap(async (session, player, remark) => this.handleRemark(session, player || '', remark || '')))

    this.ctx.command('apexrankremove [input:text]', 'remove a watch target')
      .alias('apex\u79fb\u9664')
      .alias('\u53d6\u6d88\u6301\u7eed\u89c6\u5978')
      .action(this.wrap(async (session, input = '') => this.handleRemove(session, input)))

    this.ctx.command('apex\u65e5\u4e0a\u5206\u699c', 'show today gain leaderboard in current group')
      .action(this.wrap(async (session) => this.handleLeaderboard(session, 'day', 'gain')))

    this.ctx.command('apex\u65e5\u6389\u5206\u699c', 'show today loss leaderboard in current group')
      .action(this.wrap(async (session) => this.handleLeaderboard(session, 'day', 'loss')))

    this.ctx.command('apex\u5468\u4e0a\u5206\u699c', 'show week gain leaderboard in current group')
      .action(this.wrap(async (session) => this.handleLeaderboard(session, 'week', 'gain')))

    this.ctx.command('apex\u5468\u6389\u5206\u699c', 'show week loss leaderboard in current group')
      .action(this.wrap(async (session) => this.handleLeaderboard(session, 'week', 'loss')))

    this.ctx.command('apexpredator [platform:string]', 'query predator threshold')
      .alias('apex\u730e\u6740')
      .alias('\u730e\u6740')
      .action(this.wrap(async (session, platform = '') => this.handlePredator(session, platform)))

    this.ctx.command('apexseason [season:string]', 'query current season time')
      .alias('apex\u8d5b\u5b63')
      .alias('\u65b0\u8d5b\u5b63')
      .action(this.wrap(async (session, season = '') => this.handleSeason(session, season)))

    this.ctx.command('map', 'query ranked map rotation')
      .alias('\u5730\u56fe')
      .alias('\u6392\u4f4d\u5730\u56fe')
      .alias('apexmap')
      .alias('apexrankmap')
      .action(this.wrap(async (session) => this.handleMap(session, 'ranked')))

    this.ctx.command('\u5339\u914d\u5730\u56fe', 'query battle royale map rotation')
      .action(this.wrap(async (session) => this.handleMap(session, 'battle_royale')))

    this.ctx.command('apexblacklist [action:string] [input:text]', 'manage runtime blacklist')
      .alias('apex\u9ed1\u540d\u5355')
      .alias('\u4e0d\u51c6\u89c6\u5978')
      .alias('apexban')
      .action(this.wrap(async (session, action = '', input = '') => this.handleBlacklist(session, action, input)))

    this.ctx.command('\u8d5b\u5b63\u5173\u95ed', 'disable season keyword reply in this group')
      .action(this.wrap(async (session) => this.handleSeasonKeywordToggle(session, true)))

    this.ctx.command('\u8d5b\u5b63\u5f00\u542f', 'enable season keyword reply in this group')
      .action(this.wrap(async (session) => this.handleSeasonKeywordToggle(session, false)))
  }

  private registerSeasonKeywordMiddleware() {
    this.ctx.middleware(async (session, next) => {
      await this.ready
      const result = await next()
      if (result) return result

      const content = (session.content || '').trim()
      if (!content) return
      const raw = content.replace(/^\s+/, '')
      if (!raw || raw.startsWith('/') || raw.startsWith('\uff0f')) return

      const first = raw.split(/\s+/, 1)[0].replace(/^[/\uff0f]+/, '').trim().toLowerCase()
      if (first && SEASON_KEYWORD_COMMAND_BLOCKLIST.has(first)) return
      if (!raw.includes('\u8d5b\u5b63')) return

      const groupId = this.getGroupId(session)
      if (groupId && this.isSeasonKeywordDisabled(groupId)) return
      if (this.guardAccess(session)) return

      try {
        const seasonInfo = await this.api.fetchSeasonInfo()
        const suffix = groupId ? '\n\ud83d\udd15 \u5173\u95ed\u8d5b\u5b63\u5173\u952e\u8bcd\u56de\u590d\uff1a/\u8d5b\u5b63\u5173\u95ed' : ''
        try {
          const imagePath = await this.imageRenderer.renderSeasonInfo(seasonInfo)
          return `${h.image(imagePath)}${suffix}`
        } catch {
          return `${this.formatSeasonInfo(seasonInfo)}${suffix}`
        }
      } catch (error: any) {
        this.logger.error(`season query failed: ${error?.message || error}`)
      }
    })
  }

  private wrap<T extends any[]>(handler: (session: CommandSession, ...args: T) => Promise<Fragment | void>) {
    return async ({ session }: { session?: CommandSession }, ...args: T) => {
      if (!session) return ''
      await this.ready
      return handler(session, ...args)
    }
  }

  private timeLine() {
    return `\ud83d\udd52 \u65f6\u95f4: ${formatNow()}`
  }

  private getUserId(session: CommandSession) {
    return String(session.userId || session.event.user?.id || '').trim()
  }

  private getGroupId(session: CommandSession) {
    if (session.isDirect) return ''
    return String(session.guildId || session.channelId || '').trim()
  }

  private extractTarget(session: CommandSession): NotificationTarget | null {
    const groupId = this.getGroupId(session)
    const channelId = String(session.channelId || groupId || '').trim()
    if (!groupId || !channelId) return null
    return {
      botSid: session.bot.sid,
      platform: session.platform,
      selfId: session.selfId,
      channelId,
      guildId: groupId,
    }
  }

  private getBotForTarget(target: NotificationTarget) {
    const bots = Array.from(this.ctx.bots as unknown as Bot[])
    return bots.find((bot) => bot.sid === target.botSid)
      || bots.find((bot) => bot.platform === target.platform && bot.selfId === target.selfId)
      || bots.find((bot) => bot.platform === target.platform)
      || bots[0]
  }

  private async sendToTarget(target: NotificationTarget | null, message: Fragment) {
    if (!target?.channelId) {
      this.logger.warn('notification target is missing')
      return false
    }
    if (target.platform === 'mock') return false

    const bot = this.getBotForTarget(target)
    if (!bot) {
      this.logger.warn(`no available bot for channel ${target.channelId}`)
      return false
    }

    try {
      await bot.sendMessage(target.channelId, message)
      return true
    } catch (error) {
      this.logger.error(`active send failed: ${String((error as Error)?.message || error)}`)
      try {
        if (typeof message === 'string' && typeof bot.internal?.sendGroupMsg === 'function') {
          await bot.internal.sendGroupMsg(target.channelId, message)
          return true
        }
      } catch (fallbackError) {
        this.logger.error(`fallback send failed: ${String((fallbackError as Error)?.message || fallbackError)}`)
      }
      return false
    }
  }

  private isOwner(userId: string) {
    return !!userId && this.ownerSet.has(userId)
  }

  private isAdmin(session: CommandSession) {
    const userId = this.getUserId(session)
    if (this.isOwner(userId)) return true
    const roles = session.author?.roles || session.event.member?.roles || []
    return roles.some((role) => {
      const text = `${role.name || ''}:${role.id || ''}`.toLowerCase()
      return text.includes('admin') || text.includes('owner')
    })
  }

  private guardAdmin(session: CommandSession) {
    if (this.isAdmin(session)) return ''
    return '\u26a0\ufe0f \u6b64\u547d\u4ee4\u4ec5\u7ba1\u7406\u5458\u53ef\u7528\uff0c\u8bf7\u5728\u914d\u7f6e\u4e2d\u8bbe\u7f6e ownerQq \u6216\u4f7f\u7528\u7fa4\u7ba1\u7406\u5458\u8d26\u53f7\u6267\u884c\u3002'
  }

  private guardAccess(session: CommandSession, requireGroup = false) {
    const userId = this.getUserId(session)
    if (this.isOwner(userId)) return ''
    if (userId && this.userBlacklist.has(userId)) {
      return '\u26d4 \u4f60\u5df2\u88ab\u7981\u6b62\u4f7f\u7528\u6b64\u63d2\u4ef6\u3002'
    }

    const groupId = this.getGroupId(session)
    if (requireGroup && !groupId) {
      return '\u26a0\ufe0f \u6b64\u547d\u4ee4\u4ec5\u9002\u7528\u4e8e\u7fa4\u804a\uff0c\u8bf7\u5728\u7fa4\u804a\u4e2d\u4f7f\u7528\u3002'
    }
    if (!groupId && !this.config.allowPrivate) {
      return '\u26a0\ufe0f \u5f53\u524d\u4e0d\u5141\u8bb8\u79c1\u804a\u4f7f\u7528\uff0c\u8bf7\u5728\u7fa4\u804a\u4e2d\u4f7f\u7528\u3002'
    }
    if (groupId && this.config.whitelistEnabled && !this.whitelistGroups.has(groupId)) {
      return '\u26a0\ufe0f \u672c\u7fa4\u672a\u5728\u767d\u540d\u5355\u4e2d\uff0c\u65e0\u6cd5\u4f7f\u7528\u6b64\u63d2\u4ef6\u3002'
    }
    return ''
  }

  private isBlacklisted(playerName: string) {
    const name = normalizeLookupValue(playerName)
    return !!name && (this.configBlacklist.has(name) || this.settings.runtimeBlacklist.includes(name))
  }

  private isQueryBlocked(playerName: string) {
    const name = normalizeLookupValue(playerName)
    return !!name && this.queryBlocklist.has(name)
  }

  private isSeasonKeywordDisabled(groupId: string) {
    return !!groupId && this.settings.seasonKeywordDisabledGroups.includes(groupId)
  }

  private async saveSettings() {
    await this.settingsStore.save(this.settings)
  }

  private parsePlayerPlatformInput(input: string) {
    const text = String(input || '').trim()
    if (!text) return { playerName: '', platform: '' }
    const parts = text.split(/\s+/)
    const last = parts[parts.length - 1]
    const normalized = normalizePlatform(last)
    if (parts.length > 1 && ['PC', 'PS4', 'X1', 'SWITCH'].includes(normalized)) {
      return {
        playerName: parts.slice(0, -1).join(' ').trim(),
        platform: normalized,
      }
    }
    return { playerName: text, platform: '' }
  }

  private splitBlacklistItems(input: string) {
    return Array.from(new Set(String(input || '').replace(/\uff0c/g, ',').split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)))
  }

  private findPlayerKey(group: StoredGroupRecord, playerName: string, platform: string, useUid: boolean) {
    const { identifier, useUid: parsedUseUid } = parseIdentifier(playerName)
    const finalUseUid = useUid || parsedUseUid
    if (!identifier) return ''
    if (platform) {
      const key = buildPlayerKey(identifier, platform, finalUseUid)
      return group.players[key] ? key : ''
    }
    const prefix = `${finalUseUid ? 'uid:' : 'name:'}${identifier.toLowerCase()}@`
    const matches = Object.keys(group.players).filter((key) => key.startsWith(prefix))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) return '__MULTI__'
    return ''
  }

  private async migrateStoreKeys() {
    let changed = false
    for (const [groupId, group] of this.groupStore.entries()) {
      const nextPlayers: Record<string, StoredPlayerRecord> = {}
      for (const [oldKey, record] of Object.entries(group.players)) {
        const platform = normalizePlatform(record.platform || 'PC')
        const lookupId = record.lookupId || record.playerName
        const useUid = Boolean(record.useUid)
        const key = buildPlayerKey(lookupId, platform, useUid)
        nextPlayers[key] = { ...record, platform, lookupId, useUid }
        if (oldKey !== key || record.platform !== platform || record.lookupId !== lookupId || Boolean(record.useUid) !== useUid) {
          changed = true
        }
      }
      group.players = nextPlayers
      if (!group.target && Object.keys(group.players).length) {
        group.target = {
          botSid: '',
          platform: 'onebot',
          selfId: '',
          channelId: groupId,
          guildId: groupId,
        }
        changed = true
      }
    }
    if (changed) await this.groupStore.save()
  }

  private apiKeyApplyUrl() {
    return 'https://portal.apexlegendsapi.com/'
  }

  private missingApiKeyText() {
    return [
      this.timeLine(),
      '\u26a0\ufe0f \u8bf7\u5148\u5728\u63d2\u4ef6\u914d\u7f6e\u4e2d\u586b\u5199 API Key\u3002',
      `\ud83d\udd17 Key \u7533\u8bf7\u5730\u5740: ${this.apiKeyApplyUrl()}`,
    ].join('\n')
  }

  private apiRequestFailedText(action = '\u67e5\u8be2') {
    return [
      this.timeLine(),
      `\u274c ${action}\u5931\u8d25\uff1a\u8bf7\u68c0\u67e5\u7f51\u7edc\u3001API Key \u662f\u5426\u6709\u6548\uff0c\u6216\u7a0d\u540e\u518d\u8bd5\u3002`,
      `\ud83d\udd17 Key \u7533\u8bf7\u5730\u5740: ${this.apiKeyApplyUrl()}`,
    ].join('\n')
  }

  private imageRenderOptions() {
    return {
      checkInterval: this.config.checkInterval,
      minValidScore: this.config.minValidScore,
      configBlacklistCount: this.configBlacklist.size,
      runtimeBlacklistCount: this.settings.runtimeBlacklist.length,
      queryBlocklistCount: this.queryBlocklist.size,
    }
  }

  private getBindingUserId(session: CommandSession) {
    return this.getUserId(session)
  }

  private getBoundRecord(session: CommandSession) {
    const userId = this.getBindingUserId(session)
    if (!userId) return null
    return this.bindingStore.get(userId) || null
  }

  private formatBoundPlayer(record: UserBindingRecord, displayName = '') {
    const display = displayName || formatPlayerDisplayName(record.playerName)
    const identifier = formatLookupIdentifier(record.lookupId, record.useUid)
    return [
      `👤 绑定账号: ${display}`,
      `🕹️ 平台: ${formatPlatform(record.platform)}`,
      identifier ? `🔎 标识: ${identifier}` : '',
      record.uid ? `🆔 UID: ${record.uid}` : '',
    ].filter(Boolean)
  }

  private getPlayerDisplayName(record: Pick<StoredPlayerRecord, 'playerName' | 'remark'>, includeOriginal = true) {
    return formatPlayerDisplayName(record.playerName, record.remark, includeOriginal)
  }

  private findStoredRemark(lookupId: string, platform: string, useUid: boolean, preferredGroupId = '') {
    const playerKey = buildPlayerKey(lookupId, platform, useUid)
    if (preferredGroupId) {
      const preferredGroup = this.groupStore.getGroup(preferredGroupId)
      const preferredRemark = sanitizeRemark(preferredGroup?.players?.[playerKey]?.remark)
      if (preferredRemark) return preferredRemark
    }
    for (const [groupId, group] of this.groupStore.entries()) {
      if (groupId === preferredGroupId) continue
      const remark = sanitizeRemark(group.players[playerKey]?.remark)
      if (remark) return remark
    }
    return ''
  }

  private resolveBoundDisplayName(session: CommandSession, record: UserBindingRecord) {
    const preferredGroupId = this.getGroupId(session)
    const remark = this.findStoredRemark(record.lookupId, record.platform, record.useUid, preferredGroupId)
    return formatPlayerDisplayName(record.playerName, remark)
  }

  private createScoreHistoryEntry(groupId: string, playerKey: string, player: StoredPlayerRecord, oldScore: number, newScore: number): ScoreHistoryEntry {
    const remarkSnapshot = sanitizeRemark(player.remark) || undefined
    return {
      groupId,
      playerKey,
      playerName: player.playerName,
      remarkSnapshot,
      displayNameSnapshot: this.getPlayerDisplayName(player),
      platform: normalizePlatform(player.platform || 'PC'),
      ownerUserIdSnapshot: player.ownerUserId,
      oldScore,
      newScore,
      delta: newScore - oldScore,
      recordedAt: Date.now(),
    }
  }

  private buildLeaderboard(groupId: string, period: 'day' | 'week', direction: 'gain' | 'loss') {
    const { start, endExclusive } = getBeijingLeaderboardRange(period)
    const entries = this.scoreHistoryStore.listByGroup(groupId)
      .filter((entry) => isTimestampInRange(entry.recordedAt, start, endExclusive))
    const summarized = summarizeLeaderboard(entries)
      .filter((entry) => direction === 'gain' ? entry.netDelta > 0 : entry.netDelta < 0)
      .sort((left, right) => direction === 'gain' ? right.netDelta - left.netDelta : left.netDelta - right.netDelta)
    return {
      start,
      endExclusive,
      entries: summarized,
    }
  }

  private formatLeaderboardTitle(period: 'day' | 'week', direction: 'gain' | 'loss') {
    const periodLabel = period === 'day' ? '日' : '周'
    return direction === 'gain' ? `📈 Apex ${periodLabel}上分榜` : `📉 Apex ${periodLabel}掉分榜`
  }

  private formatLeaderboardPeriodText(start: number, endExclusive: number) {
    const end = Math.max(start, endExclusive - 1)
    return `统计范围（北京时间）：${this.formatTimestampForLeaderboard(start)} ~ ${this.formatTimestampForLeaderboard(end)}`
  }

  private formatTimestampForLeaderboard(timestamp: number) {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    return formatter.format(new Date(timestamp)).replace(/\//g, '-')
  }

  private formatLeaderboardText(title: string, start: number, endExclusive: number, entries: LeaderboardEntry[], direction: 'gain' | 'loss') {
    const lines = [this.timeLine(), title, this.formatLeaderboardPeriodText(start, endExclusive)]
    if (!entries.length) {
      lines.push('ℹ️ 当前统计周期内暂无符合条件的分数变化记录。')
      return lines.join('\n')
    }

    entries.slice(0, 10).forEach((entry, index) => {
      const deltaText = direction === 'gain' ? `+${entry.netDelta}` : `-${Math.abs(entry.netDelta)}`
      lines.push(`${index + 1}. ${entry.displayName}`)
      lines.push(`   平台：${formatPlatform(entry.platform)} ｜ 变动：${deltaText} ｜ 当前分：${entry.latestScore}`)
    })
    return lines.join('\n')
  }

  private buildLeaderboardRenderRequest(period: 'day' | 'week', direction: 'gain' | 'loss', start: number, endExclusive: number, entries: LeaderboardEntry[]): LeaderboardRenderRequest {
    const title = this.formatLeaderboardTitle(period, direction)
    return {
      title,
      periodLabel: period === 'day' ? '日' : '周',
      directionLabel: direction === 'gain' ? '上分' : '掉分',
      periodRangeText: this.formatLeaderboardPeriodText(start, endExclusive),
      entries,
      renderMode: this.config.leaderboardRenderMode,
      enableLegacyImageFallback: this.config.leaderboardEnableLegacyImageFallback,
      enableTextFallback: this.config.leaderboardEnableTextFallback,
    }
  }

  private async renderLeaderboardResult(period: 'day' | 'week', direction: 'gain' | 'loss', start: number, endExclusive: number, entries: LeaderboardEntry[]) {
    const request = this.buildLeaderboardRenderRequest(period, direction, start, endExclusive, entries)
    return renderLeaderboardOutput(request, {
      imageRenderer: this.imageRenderer,
      logger: this.logger,
      runtimeConfig: {
        renderMode: this.config.leaderboardRenderMode,
        enableLegacyImageFallback: this.config.leaderboardEnableLegacyImageFallback,
        enableTextFallback: this.config.leaderboardEnableTextFallback,
        resourceDir: this.config.leaderboardResourceDir,
        avatarCacheTTL: this.config.leaderboardAvatarCacheTTL,
        avatarFailureCacheTTL: this.config.leaderboardAvatarFailureCacheTTL,
        avatarFetchTimeout: this.config.leaderboardAvatarFetchTimeout,
        viewportWidth: this.config.leaderboardViewportWidth,
        deviceScaleFactor: this.config.leaderboardDeviceScaleFactor,
        waitUntil: this.config.leaderboardWaitUntil,
        maxRowsPerImage: this.config.leaderboardMaxRowsPerImage,
        titleFont: this.config.leaderboardTitleFont,
        bodyFont: this.config.leaderboardBodyFont,
        numberFont: this.config.leaderboardNumberFont,
        fontFallbackEnabled: this.config.leaderboardFontFallbackEnabled,
        themePreset: this.config.leaderboardThemePreset,
        backgroundType: this.config.leaderboardBackgroundType,
        backgroundValue: this.config.leaderboardBackgroundValue,
        backgroundApiKey: this.config.leaderboardBackgroundApiKey,
        customCss: this.config.leaderboardCustomCss,
      },
      resourceLayout: getLeaderboardResourceLayout(this.config.leaderboardResourceDir),
      puppeteer: {
        browser: (this.ctx.puppeteer as any)?.browser,
      },
    })
  }

  private async queryPlayerByInput(input: string) {
    const { playerName, platform } = this.parsePlayerPlatformInput(input)
    if (!playerName) return { error: '⚠️ 请输入玩家名称，例如：/apexrank moeneri。' }
    if (this.isBlacklisted(playerName) || this.isQueryBlocked(playerName)) {
      return { error: `⛔ 该 ID（${playerName}）已被管理员加入黑名单，禁止查询。` }
    }

    const { identifier, useUid } = parseIdentifier(playerName)
    if (!identifier) return { error: '⚠️ 请输入有效的玩家名称或 UID。' }

    const { player, platform: usedPlatform } = await this.api.fetchPlayerStatsAuto(identifier, platform, useUid)
    return { player, usedPlatform, identifier, useUid }
  }

  private async renderRankQueryResult(player: ApexPlayerStats, usedPlatform: string, displayName = '') {
    if (player.rankScore < this.config.minValidScore) {
      return [this.timeLine(), `⚠️ 查询到 ${player.name} 的分数为 ${player.rankScore}，低于最低有效分数 ${this.config.minValidScore}，可能是 API 异常，请稍后再试。`].join('\n')
    }
    player.platform = usedPlatform
    const renderPlayer = {
      ...player,
      displayName: displayName || player.name,
    }
    try {
      const imagePath = await this.imageRenderer.renderPlayerRank(renderPlayer)
      return h.image(imagePath)
    } catch (error) {
      this.logger.error(`player rank image render failed: ${String((error as Error)?.message || error)}`)
      return this.formatPlayerRankText(renderPlayer)
    }
  }

  private async handleRankQuery(session: CommandSession, input: string) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')
    if (!this.config.apiKey) return this.missingApiKeyText()

    try {
      const result = await this.queryPlayerByInput(input)
      if ('error' in result) return [this.timeLine(), result.error].join('\n')
      return this.renderRankQueryResult(result.player, result.usedPlatform)
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        return [this.timeLine(), '⚠️ 未找到该玩家，请检查名称是否正确，或在命令末尾指定平台。'].join('\n')
      }
      this.logger.error(`rank query failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('查询')
    }
  }

  private async handleBoundRankQuery(session: CommandSession, input: string) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')
    if (!this.config.apiKey) return this.missingApiKeyText()

    const rawInput = String(input || '').trim()
    if (rawInput) return this.handleRankQuery(session, rawInput)

    const binding = this.getBoundRecord(session)
    if (!binding) {
      return [
        this.timeLine(),
        '⚠️ 你还没有绑定 Apex 账号。',
        '可使用：/apex绑定 <玩家名|uid:...> [平台]',
      ].join('\n')
    }
    const displayName = this.resolveBoundDisplayName(session, binding)
    if (this.isBlacklisted(binding.lookupId) || this.isQueryBlocked(binding.lookupId)) {
      return [this.timeLine(), `⛔ 绑定账号（${displayName}）已被管理员加入黑名单，禁止查询。`].join('\n')
    }

    try {
      const { player, platform: usedPlatform } = await this.api.fetchPlayerStatsAuto(binding.lookupId, binding.platform, binding.useUid)
      return this.renderRankQueryResult(player, usedPlatform, displayName)
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        return [
          this.timeLine(),
          '⚠️ 当前绑定账号已无法查询，请重新绑定。',
          '可使用：/apex绑定 <玩家名|uid:...> [平台]',
        ].join('\n')
      }
      this.logger.error(`bound rank query failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('查询')
    }
  }

  private async handleBind(session: CommandSession, input: string) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')
    if (!this.config.apiKey) return this.missingApiKeyText()

    const userId = this.getBindingUserId(session)
    if (!userId) return [this.timeLine(), '⚠️ 当前会话无法识别用户，暂时不能绑定 Apex 账号。'].join('\n')

    try {
      const result = await this.queryPlayerByInput(input)
      if ('error' in result) return [this.timeLine(), result.error].join('\n')
      const { player, usedPlatform, identifier, useUid } = result
      if (player.rankScore < this.config.minValidScore) {
        return [this.timeLine(), `⚠️ 查询到 ${player.name} 的分数为 ${player.rankScore}，低于最低有效分数 ${this.config.minValidScore}，可能是 API 异常，请稍后再试。`].join('\n')
      }

      const record: UserBindingRecord = {
        userId,
        lookupId: identifier,
        useUid,
        platform: normalizePlatform(usedPlatform),
        playerName: player.name,
        uid: player.uid || '',
        updatedAt: Date.now(),
      }
      this.bindingStore.set(record)
      await this.bindingStore.save()

      return [
        this.timeLine(),
        '✅ 已绑定 Apex 账号。',
        ...this.formatBoundPlayer(record),
        '💡 之后可直接使用：/apex查分',
      ].join('\n')
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        return [this.timeLine(), '⚠️ 未找到该玩家，请检查名称是否正确，或在命令末尾指定平台。'].join('\n')
      }
      this.logger.error(`bind account failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('绑定账号')
    }
  }

  private async handleUnbind(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    const userId = this.getBindingUserId(session)
    if (!userId) return [this.timeLine(), '⚠️ 当前会话无法识别用户，暂时不能解绑 Apex 账号。'].join('\n')
    if (!this.bindingStore.remove(userId)) {
      return [this.timeLine(), 'ℹ️ 你当前还没有绑定 Apex 账号。'].join('\n')
    }
    await this.bindingStore.save()
    return [this.timeLine(), '✅ 已解绑当前 Apex 账号。'].join('\n')
  }

  private async handleBindingInfo(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    const binding = this.getBoundRecord(session)
    if (!binding) {
      return [
        this.timeLine(),
        'ℹ️ 你当前还没有绑定 Apex 账号。',
        '可使用：/apex绑定 <玩家名|uid:...> [平台]',
      ].join('\n')
    }

    return [
      this.timeLine(),
      '📌 当前绑定的 Apex 账号信息',
      ...this.formatBoundPlayer(binding, this.resolveBoundDisplayName(session, binding)),
    ].join('\n')
  }

  private async handleTest(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    const target = this.extractTarget(session)
    if (!target) {
      return [this.timeLine(), '\u2705 Apex Legends \u6392\u540d\u76d1\u63a7\u63d2\u4ef6\u6b63\u5e38\u8fd0\u884c\u4e2d\u3002'].join('\n')
    }

    const success = await this.sendToTarget(target, '\u2705 Apex Legends \u6392\u540d\u76d1\u63a7\u6d4b\u8bd5\u6d88\u606f')
    if (success) {
      return [this.timeLine(), '\u2705 Apex Legends \u6392\u540d\u76d1\u63a7\u63d2\u4ef6\u6b63\u5e38\u8fd0\u884c\u4e2d\uff0c\u6d4b\u8bd5\u6d88\u606f\u5df2\u53d1\u9001\u5230\u5f53\u524d\u4f1a\u8bdd\u3002'].join('\n')
    }
    return [this.timeLine(), '\u26a0\ufe0f \u6307\u4ee4\u53ef\u7528\uff0c\u4f46\u5f53\u524d\u5e73\u53f0\u6216\u9002\u914d\u5668\u4e0d\u652f\u6301\u4e3b\u52a8\u6d88\u606f\u63a8\u9001\u3002'].join('\n')
  }

  private async handleHelp(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    try {
      const imagePath = await this.imageRenderer.renderHelp(this.imageRenderOptions())
      return h.image(imagePath)
    } catch (error) {
      this.logger.error(`help image render failed: ${String((error as Error)?.message || error)}`)
    }

    const lines = [
      this.timeLine(),
      '📖 Apex Rank Watch 帮助',
      '【查询】',
      '/apexrank <玩家|uid:...> [平台]  别名：/apex查询 /视奸',
      '示例：/apexrank moeneri pc',
      '/apex查分 [玩家|uid:...]',
      '/apex绑定 <玩家|uid:...> [平台]、/apex解绑、/apex我的账号、/apex绑定信息',
      '【监控（群聊）】',
      '/apexrankwatch <玩家|uid:...> [平台]  别名：/apex监控 /持续视奸',
      '/apexranklist  别名：/apex列表（有备注时优先显示备注名）',
      '/apexremark <玩家|uid:...> [平台] [备注]  别名：/apex备注',
      '/apex日上分榜 /apex日掉分榜 /apex周上分榜 /apex周掉分榜',
      'HTML 榜单支持独立资源目录、内置字体回退、背景预设 / 本地文件 / URL / API / 自定义 CSS。',
      'HTML 榜单头像默认使用“添加该监控项的 QQ 用户头像”，并带有成功 / 失败缓存回退。',
      '/apexrankremove <玩家|uid:...> [平台]  别名：/apex移除 /取消持续视奸',
      '【信息】',
      '/map  别名：/地图 /排位地图 /apexmap /apexrankmap',
      '/匹配地图',
      '/apexpredator [平台]  别名：/apex猎杀 /猎杀',
      '/apexseason [赛季号|current]  别名：/apex赛季 /新赛季',
      '关键词：消息包含“赛季”自动回复（/赛季关闭，/赛季开启）',
      '【管理】',
      '/apexblacklist <add|remove|list|clear> <玩家ID>  别名：/apex黑名单 /不准视奸 /apexban',
      '【参数】',
      '平台：PC / PS4 / X1 / SWITCH（未指定时按 PC -> PS4 -> X1 -> SWITCH 自动尝试）',
      'UUID：使用 uid: 或 uuid: 前缀，例如 /apexrank uid:123456',
      `⏱️ 监控间隔：${this.config.checkInterval} 分钟`,
      `🎯 最低有效分数：${this.config.minValidScore} 分`,
      '⚠️ 异常分数判定：仅当高分（>1000）跌到接近 0 分（<10）时才判定为异常',
      '🛡️ 权限：支持群白名单、用户黑名单、主人账号和私聊开关',
    ]

    const totalBlacklist = this.configBlacklist.size + this.settings.runtimeBlacklist.length
    if (totalBlacklist) {
      lines.push(`⛔ 黑名单说明：配置黑名单 ${this.configBlacklist.size} 个，动态黑名单 ${this.settings.runtimeBlacklist.length} 个。`)
    }
    if (this.queryBlocklist.size) {
      lines.push(`⛔ 查询封禁玩家：已配置 ${this.queryBlocklist.size} 个。`)
    }
    return lines.join('\n')
  }

  private async handleLeaderboard(session: CommandSession, period: 'day' | 'week', direction: 'gain' | 'loss') {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const groupId = this.getGroupId(session)
    if (!groupId) {
      return [this.timeLine(), '⚠️ 此命令仅适用于群聊，请在群聊中使用。'].join('\n')
    }

    const { start, endExclusive, entries } = this.buildLeaderboard(groupId, period, direction)
    return this.renderLeaderboardResult(period, direction, start, endExclusive, entries)
  }

  private async handleMap(session: CommandSession, mode: 'ranked' | 'battle_royale') {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')
    if (!this.config.apiKey) return this.missingApiKeyText()

    try {
      const rotationInfo = await this.api.fetchMapRotationInfo()
      try {
        const imagePath = await this.imageRenderer.renderMapRotation(rotationInfo, mode)
        return h.image(imagePath)
      } catch (error) {
        this.logger.error(`map rotation image render failed: ${String((error as Error)?.message || error)}`)
        return this.formatMapRotationText(rotationInfo, mode)
      }
    } catch (error) {
      this.logger.error(`map rotation query failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText(mode === 'battle_royale' ? '\u5339\u914d\u5730\u56fe\u67e5\u8be2' : '\u5730\u56fe\u8f6e\u6362\u67e5\u8be2')
    }
  }

  private async handlePredator(session: CommandSession, platform = '') {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')
    if (!this.config.apiKey) return this.missingApiKeyText()

    const selectedPlatform = platform ? normalizePlatform(platform) : ''
    if (platform && !['PC', 'PS4', 'X1', 'SWITCH'].includes(selectedPlatform)) {
      return [
        this.timeLine(),
        '\u26a0\ufe0f \u5e73\u53f0\u4ec5\u652f\u6301 PC / PS4 / X1 / SWITCH\u3002',
        '\u4f8b\uff1a/apexpredator pc  \u6216  /\u730e\u6740',
      ].join('\n')
    }

    try {
      const predatorInfo = await this.api.fetchPredatorInfo()
      if (!predatorInfo.platforms.length) {
        return [this.timeLine(), '\u26a0\ufe0f \u6682\u672a\u83b7\u53d6\u5230\u730e\u6740\u95e8\u69db\u6570\u636e\u3002'].join('\n')
      }
      try {
        const imagePath = await this.imageRenderer.renderPredatorInfo(predatorInfo)
        return h.image(imagePath)
      } catch (error) {
        this.logger.error(`predator image render failed: ${String((error as Error)?.message || error)}`)
        return this.formatPredatorInfoText(predatorInfo, selectedPlatform)
      }
    } catch (error) {
      this.logger.error(`predator query failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('\u67e5\u8be2')
    }
  }

  private async handleSeason(session: CommandSession, season = '') {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    const seasonNumber = this.parseSeasonQuery(season)
    if (seasonNumber === false) {
      return [
        this.timeLine(),
        '\u26a0\ufe0f \u8bf7\u8f93\u5165\u6b63\u786e\u7684\u8d5b\u5b63\u53f7\uff0c\u4f8b\u5982 /apexseason 28 \u6216 /apexseason current\u3002',
      ].join('\n')
    }

    try {
      const seasonInfo = await this.api.fetchSeasonInfo(seasonNumber)
      try {
        const imagePath = await this.imageRenderer.renderSeasonInfo(seasonInfo)
        return h.image(imagePath)
      } catch (error) {
        this.logger.error(`season image render failed: ${String((error as Error)?.message || error)}`)
        return this.formatSeasonInfo(seasonInfo)
      }
    } catch (error) {
      this.logger.error(`season query failed: ${String((error as Error)?.message || error)}`)
      return [this.timeLine(), '\u274c \u67e5\u8be2\u5931\u8d25\uff1a\u65e0\u6cd5\u83b7\u53d6\u8d5b\u5b63\u65f6\u95f4\u4fe1\u606f\u3002'].join('\n')
    }
  }

  private parseSeasonQuery(raw: string): number | null | false {
    const token = String(raw || '').trim().toLowerCase()
    if (!token || ['current', 'curr', 'now', 'latest', '\u6700\u65b0', '\u5f53\u524d'].includes(token)) return null
    const value = Number(token)
    if (!Number.isInteger(value) || value < 1 || value > 99) return false
    return value
  }

  private formatMapRotationText(rotationInfo: MapRotationInfo, mode: 'ranked' | 'battle_royale' = 'ranked') {
    const rotationMode = mode === 'battle_royale' ? rotationInfo.battleRoyale : rotationInfo.ranked
    const currentLabel = mode === 'battle_royale' ? '\u5f53\u524d\u4e09\u4eba\u8d5b\u5730\u56fe' : '\u5f53\u524d\u6392\u4f4d\u5730\u56fe'
    const title = mode === 'battle_royale' ? '\ud83d\uddfa\ufe0f Apex \u4e09\u4eba\u8d5b\u5730\u56fe\u8f6e\u6362' : '\ud83d\uddfa\ufe0f Apex \u6392\u4f4d\u5730\u56fe\u8f6e\u6362'
    if (!rotationMode.current) {
      return [this.timeLine(), mode === 'battle_royale' ? '\u26a0\ufe0f \u6682\u672a\u83b7\u53d6\u5230\u4e09\u4eba\u8d5b\u5730\u56fe\u8f6e\u6362\u6570\u636e\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002' : '\u26a0\ufe0f \u6682\u672a\u83b7\u53d6\u5230\u6392\u4f4d\u5730\u56fe\u8f6e\u6362\u6570\u636e\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002'].join('\n')
    }
    const current = rotationMode.current
    const next = rotationMode.next
    const lines = [
      `\ud83d\udccd ${currentLabel}\uff1a${this.formatMapName(current)}`,
      `\ud83d\udd52 \u67e5\u8be2\u65f6\u95f4\uff1a${formatNow()}`,
      title,
      '\u2014\u2014',
      `\u23f0 \u672c\u8f6e\u65f6\u95f4\uff1a${this.formatRotationRange(current)}`,
    ]
    if (current.remainingTimer) lines.push(`\u23f3 \u5269\u4f59\u65f6\u95f4\uff1a${current.remainingTimer}`)
    if (next) {
      lines.push('\u2014\u2014', `\u27a1\ufe0f \u4e0b\u4e00\u5f20\uff1a${this.formatMapName(next)}`, `\u23f0 \u4e0b\u8f6e\u65f6\u95f4\uff1a${this.formatRotationRange(next)}`)
    }
    lines.push('\u2139\ufe0f \u65f6\u95f4\u5747\u4e3a\u5317\u4eac\u65f6\u95f4')
    return lines.join('\n')
  }

  private formatMapName(entry: { mapName: string; mapNameZh: string }) {
    return entry.mapNameZh && entry.mapNameZh !== entry.mapName ? `${entry.mapNameZh} / ${entry.mapName}` : entry.mapNameZh || entry.mapName || '\u672a\u77e5'
  }

  private formatRotationRange(entry: { start: number | null; end: number | null }) {
    return `${this.formatTimestampToBeijing(entry.start)} ~ ${this.formatTimestampToBeijing(entry.end)}`
  }

  private formatTimestampToBeijing(timestamp: number | null) {
    if (!timestamp) return '\u672a\u77e5'
    const date = new Date(timestamp * 1000)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  private formatPredatorInfoText(predatorInfo: { mode: string; platforms: { platform: string; requiredRp: number | null; mastersCount: number | null; updateTimestamp: number | null }[] }, selectedPlatform = '') {
    const platforms = selectedPlatform
      ? predatorInfo.platforms.filter((entry) => entry.platform === selectedPlatform)
      : predatorInfo.platforms
    const lines = [this.timeLine(), '\ud83c\udff9 Apex \u730e\u6740\u7ebf\u4e0e\u5927\u5e08\u6570\u91cf']
    lines.push(`\ud83c\udfae \u6a21\u5f0f: ${predatorInfo.mode === 'RP' ? '\u6392\u4f4d\u79ef\u5206 (RP)' : predatorInfo.mode}`)
    for (const entry of platforms) {
      const threshold = entry.requiredRp === null ? '\u672a\u77e5' : entry.requiredRp.toLocaleString()
      const masters = entry.mastersCount === null ? '\u672a\u77e5' : entry.mastersCount.toLocaleString()
      lines.push(`\ud83d\udd79\ufe0f ${formatPlatform(entry.platform)}\uff1a\u730e\u6740\u7ebf ${threshold} RP\uff5c\u5927\u5e08\u6570\u91cf ${masters}\uff08\u5305\u542b\u730e\u6740\uff09`)
    }
    return lines.join('\n')
  }

  private async handleSeasonKeywordToggle(session: CommandSession, disabled: boolean) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')
    const adminDeny = this.guardAdmin(session)
    if (adminDeny) return [this.timeLine(), adminDeny].join('\n')

    const groupId = this.getGroupId(session)
    if (!groupId) {
      return [this.timeLine(), '\u26a0\ufe0f \u6b64\u547d\u4ee4\u4ec5\u9002\u7528\u4e8e\u7fa4\u804a\uff0c\u8bf7\u5728\u7fa4\u804a\u4e2d\u4f7f\u7528\u3002'].join('\n')
    }

    const set = new Set(this.settings.seasonKeywordDisabledGroups)
    if (disabled) set.add(groupId)
    else set.delete(groupId)
    this.settings.seasonKeywordDisabledGroups = Array.from(set)
    await this.saveSettings()

    return [this.timeLine(), disabled ? '\ud83d\udd15 \u5df2\u5173\u95ed\u672c\u7fa4\u8d5b\u5b63\u5173\u952e\u8bcd\u81ea\u52a8\u56de\u590d\u3002' : '\u2705 \u5df2\u5f00\u542f\u672c\u7fa4\u8d5b\u5b63\u5173\u952e\u8bcd\u81ea\u52a8\u56de\u590d\u3002'].join('\n')
  }

  private async handleWatch(session: CommandSession, input: string) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const { playerName, platform } = this.parsePlayerPlatformInput(input)
    if (!playerName) {
      return [this.timeLine(), '\u26a0\ufe0f \u8bf7\u63d0\u4f9b\u8981\u76d1\u63a7\u7684\u73a9\u5bb6\u540d\u79f0\uff0c\u4f8b\u5982\uff1a/apexrankwatch moeneri'].join('\n')
    }

    const groupId = this.getGroupId(session)
    const target = this.extractTarget(session)
    if (!groupId || !target) {
      return [this.timeLine(), '\u26a0\ufe0f \u5f53\u524d\u4f1a\u8bdd\u65e0\u6cd5\u8bc6\u522b\u7fa4\u804a\u76ee\u6807\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002'].join('\n')
    }
    if (this.isBlacklisted(playerName) || this.isQueryBlocked(playerName)) {
      return [this.timeLine(), `\u26d4 \u8be5 ID\uff08${playerName}\uff09\u5df2\u88ab\u7ba1\u7406\u5458\u52a0\u5165\u9ed1\u540d\u5355\uff0c\u7981\u6b62\u76d1\u63a7\u3002`].join('\n')
    }
    if (!this.config.apiKey) return this.missingApiKeyText()

    const { identifier, useUid } = parseIdentifier(playerName)
    if (!identifier) {
      return [this.timeLine(), '\u26a0\ufe0f \u8bf7\u63d0\u4f9b\u6709\u6548\u7684\u73a9\u5bb6\u540d\u79f0\u6216 UID\u3002'].join('\n')
    }

    try {
      const { player, platform: usedPlatform } = await this.api.fetchPlayerStatsAuto(identifier, platform, useUid)
      if (player.rankScore < this.config.minValidScore) {
        return [this.timeLine(), `\u26a0\ufe0f \u67e5\u8be2\u5230 ${playerName} \u7684\u5206\u6570\u4e3a ${player.rankScore}\uff0c\u4f4e\u4e8e\u6700\u4f4e\u6709\u6548\u5206\u6570 ${this.config.minValidScore}\uff0c\u53ef\u80fd\u662f API \u5f02\u5e38\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002`].join('\n')
      }

      const normalizedPlatform = normalizePlatform(usedPlatform)
      const playerKey = buildPlayerKey(identifier, normalizedPlatform, useUid)
      const group = this.groupStore.ensureGroup(groupId, target)
      if (group.players[playerKey]) {
        return [this.timeLine(), `\u2139\ufe0f \u672c\u7fa4\u5df2\u7ecf\u5728\u76d1\u63a7 ${player.name} \u7684\u6392\u540d\u53d8\u5316\u3002`].join('\n')
      }

      this.groupStore.updateTarget(groupId, target)
      this.groupStore.setPlayer(groupId, playerKey, {
        playerName: player.name,
        platform: normalizedPlatform,
        lookupId: identifier,
        useUid,
        rankScore: player.rankScore,
        rankName: player.rankName,
        rankDiv: player.rankDiv,
        lastChecked: Date.now(),
        globalRankPercent: player.globalRankPercent,
        selectedLegend: player.selectedLegend,
        legendKillsPercent: player.legendKillsRank?.globalPercent || '',
        ownerUserId: this.getUserId(session) || undefined,
      }, target)
      await this.groupStore.save()

      await this.sendToTarget(target, `\u2705 \u6d4b\u8bd5\u6d88\u606f\uff1a\u5df2\u6dfb\u52a0\u5bf9 ${player.name} \u7684\u6392\u540d\u76d1\u63a7\u3002`)
      try {
        const imagePath = await this.imageRenderer.renderMonitorAdded({ ...player, displayName: player.name }, normalizedPlatform, this.imageRenderOptions())
        return h.image(imagePath)
      } catch (error) {
        this.logger.error(`monitor added image render failed: ${String((error as Error)?.message || error)}`)
      }
      return [
        this.timeLine(),
        `\u2705 \u6210\u529f\u6dfb\u52a0\u5bf9 ${player.name} \u7684\u6392\u540d\u76d1\u63a7\u3002`,
        `\ud83d\udd79\ufe0f \u5e73\u53f0: ${formatPlatform(normalizedPlatform)}`,
        `\ud83c\udfc6 \u5f53\u524d\u6bb5\u4f4d: ${formatRank(player.rankName, player.rankDiv)} (${player.rankScore} \u5206)`,
      ].join('\n')
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        return [this.timeLine(), '\u26a0\ufe0f \u672a\u627e\u5230\u8be5\u73a9\u5bb6\uff0c\u8bf7\u68c0\u67e5\u540d\u79f0\u662f\u5426\u6b63\u786e\uff0c\u6216\u5728\u547d\u4ee4\u672b\u5c3e\u6307\u5b9a\u5e73\u53f0\u3002'].join('\n')
      }
      this.logger.error(`watch add failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('\u6dfb\u52a0\u76d1\u63a7')
    }
  }

  private async handleList(session: CommandSession) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const groupId = this.getGroupId(session)
    const target = this.extractTarget(session)
    if (!groupId) {
      return [this.timeLine(), '\u26a0\ufe0f \u6b64\u547d\u4ee4\u4ec5\u9002\u7528\u4e8e\u7fa4\u804a\uff0c\u8bf7\u5728\u7fa4\u804a\u4e2d\u4f7f\u7528\u3002'].join('\n')
    }
    if (target) this.groupStore.updateTarget(groupId, target)

    const group = this.groupStore.getGroup(groupId)
    if (!group || !Object.keys(group.players).length) {
      return [this.timeLine(), '\u2139\ufe0f \u672c\u7fa4\u76ee\u524d\u6ca1\u6709\u76d1\u63a7\u4efb\u4f55\u73a9\u5bb6\u3002'].join('\n')
    }

    try {
      const imagePath = await this.imageRenderer.renderWatchList(Object.values(group.players), this.imageRenderOptions())
      return h.image(imagePath)
    } catch (error) {
      this.logger.error(`watch list image render failed: ${String((error as Error)?.message || error)}`)
    }

    const lines = [this.timeLine(), '\ud83d\udccb \u672c\u7fa4 Apex \u6392\u540d\u76d1\u63a7\u5217\u8868']
    let index = 0
    for (const player of Object.values(group.players)) {
      index += 1
      const displayName = player.remark ? `${player.remark} (${player.playerName})` : player.playerName
      lines.push(`\ud83d\udc64 \u73a9\u5bb6 ${index}: ${displayName}`)
      lines.push(`\ud83d\udd79\ufe0f \u5e73\u53f0: ${formatPlatform(player.platform)}`)
      lines.push(`\ud83c\udfc6 \u6bb5\u4f4d: ${formatRank(player.rankName, player.rankDiv)}`)
      lines.push(`\ud83d\udd22 \u5206\u6570: ${player.rankScore}`)
      if (player.globalRankPercent && player.globalRankPercent !== '\u672a\u77e5') {
        lines.push(`\ud83c\udf10 \u5168\u7403\u6392\u540d: ${player.globalRankPercent}%`)
      }
      if (player.selectedLegend) lines.push(`\ud83e\uddb8 \u5f53\u524d\u82f1\u96c4: ${player.selectedLegend}`)
      if (player.legendKillsPercent) lines.push(`\ud83c\udfaf \u51fb\u6740\u6392\u540d: \u5168\u7403 ${player.legendKillsPercent}%`)
      lines.push('---')
    }
    lines.push(`\ud83d\udccc \u603b\u8ba1: ${Object.keys(group.players).length} \u4e2a\u73a9\u5bb6`)
    lines.push(`\u23f1\ufe0f \u68c0\u6d4b\u95f4\u9694: ${this.config.checkInterval} \u5206\u949f`)
    lines.push(`\ud83c\udfaf \u6700\u4f4e\u6709\u6548\u5206\u6570: ${this.config.minValidScore} \u5206`)
    return lines.join('\n')
  }

  private async handleRemark(session: CommandSession, playerInput: string, remark: string) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const parsed = this.parseRemarkParts(playerInput, remark)
    const { playerName, platform } = parsed
    if (!playerName) {
      return [this.timeLine(), '\u26a0\ufe0f \u8bf7\u63d0\u4f9b\u8981\u5907\u6ce8\u7684\u73a9\u5bb6\u540d\u79f0\u6216 UID\uff0c\u4f8b\u5982\uff1a/apexremark moeneri pc \u5927\u4f6c'].join('\n')
    }

    const groupId = this.getGroupId(session)
    const target = this.extractTarget(session)
    if (!groupId) {
      return [this.timeLine(), '\u26a0\ufe0f \u6b64\u547d\u4ee4\u4ec5\u9002\u7528\u4e8e\u7fa4\u804a\uff0c\u8bf7\u5728\u7fa4\u804a\u4e2d\u4f7f\u7528\u3002'].join('\n')
    }
    if (target) this.groupStore.updateTarget(groupId, target)

    const group = this.groupStore.getGroup(groupId)
    if (!group || !Object.keys(group.players).length) {
      return [this.timeLine(), '\u2139\ufe0f \u672c\u7fa4\u76ee\u524d\u6ca1\u6709\u76d1\u63a7\u4efb\u4f55\u73a9\u5bb6\u3002'].join('\n')
    }

    const { identifier, useUid } = parseIdentifier(playerName)
    const playerKey = this.findPlayerKey(group, identifier, platform, useUid)
    if (playerKey === '__MULTI__') {
      return [this.timeLine(), '\u26a0\ufe0f \u68c0\u6d4b\u5230\u540c\u540d\u591a\u5e73\u53f0\u76d1\u63a7\uff0c\u8bf7\u6307\u5b9a\u5e73\u53f0\uff0c\u4f8b\u5982\uff1a/apexremark moeneri pc \u5927\u4f6c'].join('\n')
    }
    if (!playerKey) {
      return [this.timeLine(), `\u26a0\ufe0f \u672c\u7fa4\u6ca1\u6709\u76d1\u63a7 ${playerName}，\u65e0\u6cd5\u8bbe\u7f6e\u5907\u6ce8\u3002`].join('\n')
    }

    const record = group.players[playerKey]
    const cleanRemark = sanitizeRemark(parsed.remark)
    if (cleanRemark) {
      record.remark = cleanRemark
      await this.groupStore.save()
      return [this.timeLine(), `✅ 已将 ${record.playerName} 的备注设置为 ${cleanRemark}。`].join('\n')
    } else {
      record.remark = undefined
      await this.groupStore.save()
      return [this.timeLine(), `✅ 已清除 ${record.playerName} 的备注。`].join('\n')
    }
  }

  private parseRemarkParts(playerInput: string, remarkInput: string) {
    const parsed = this.parsePlayerPlatformInput(playerInput)
    let remark = String(remarkInput || '').trim()
    if (!parsed.platform && remark) {
      const parts = remark.split(/\s+/)
      const platform = normalizePlatform(parts[0])
      if (['PC', 'PS4', 'X1', 'SWITCH'].includes(platform)) {
        parsed.platform = platform
        remark = parts.slice(1).join(' ')
      }
    }
    return { ...parsed, remark }
  }

  private async handleRemove(session: CommandSession, input: string) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const { playerName, platform } = this.parsePlayerPlatformInput(input)
    if (!playerName) {
      return [this.timeLine(), '\u26a0\ufe0f \u8bf7\u63d0\u4f9b\u8981\u79fb\u9664\u76d1\u63a7\u7684\u73a9\u5bb6\u540d\u79f0\uff0c\u4f8b\u5982\uff1a/apexrankremove moeneri'].join('\n')
    }

    const groupId = this.getGroupId(session)
    const target = this.extractTarget(session)
    if (!groupId) {
      return [this.timeLine(), '\u26a0\ufe0f \u6b64\u547d\u4ee4\u4ec5\u9002\u7528\u4e8e\u7fa4\u804a\uff0c\u8bf7\u5728\u7fa4\u804a\u4e2d\u4f7f\u7528\u3002'].join('\n')
    }
    if (target) this.groupStore.updateTarget(groupId, target)

    const { identifier, useUid } = parseIdentifier(playerName)
    if (!identifier) {
      return [this.timeLine(), '\u26a0\ufe0f \u8bf7\u63d0\u4f9b\u6709\u6548\u7684\u73a9\u5bb6\u540d\u79f0\u6216 UID\u3002'].join('\n')
    }

    const group = this.groupStore.getGroup(groupId)
    if (!group) return [this.timeLine(), `\u2139\ufe0f \u672c\u7fa4\u6ca1\u6709\u76d1\u63a7 ${playerName}\u3002`].join('\n')

    const lookupName = useUid ? `uid:${identifier}` : identifier
    const playerKey = this.findPlayerKey(group, lookupName, platform, useUid)
    if (playerKey === '__MULTI__') {
      return [this.timeLine(), '\u26a0\ufe0f \u68c0\u6d4b\u5230\u540c\u540d\u591a\u5e73\u53f0\u76d1\u63a7\uff0c\u8bf7\u6307\u5b9a\u5e73\u53f0\uff0c\u4f8b\u5982\uff1a/apexrankremove moeneri pc'].join('\n')
    }
    if (!playerKey || !this.groupStore.removePlayer(groupId, playerKey)) {
      return [this.timeLine(), `\u2139\ufe0f \u672c\u7fa4\u6ca1\u6709\u76d1\u63a7 ${playerName}\u3002`].join('\n')
    }

    await this.groupStore.save()
    return [this.timeLine(), `\u2705 \u5df2\u79fb\u9664\u672c\u7fa4\u5bf9 ${playerName} \u7684\u6392\u540d\u76d1\u63a7\u3002`].join('\n')
  }

  private async handleBlacklist(session: CommandSession, action: string, input: string) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')
    const adminDeny = this.guardAdmin(session)
    if (adminDeny) return [this.timeLine(), adminDeny].join('\n')

    const runtimeSet = new Set(this.settings.runtimeBlacklist)
    const actionLower = String(action || '').trim().toLowerCase()

    if (!actionLower || ['help', '?', 'h', '\u5e2e\u52a9'].includes(actionLower)) {
      return [
        this.timeLine(),
        '\ud83e\uddfe Apex \u9ed1\u540d\u5355\u7ba1\u7406\uff08\u7ba1\u7406\u5458\uff09',
        '\u7528\u6cd5\uff1a/apexblacklist add <\u73a9\u5bb6ID>',
        '\u7528\u6cd5\uff1a/apexblacklist remove <\u73a9\u5bb6ID>',
        '\u7528\u6cd5\uff1a/apexblacklist list',
        '\u7528\u6cd5\uff1a/apexblacklist clear',
        `\u914d\u7f6e\u9ed1\u540d\u5355\uff1a${formatItems(this.configBlacklist)}`,
        `\u52a8\u6001\u9ed1\u540d\u5355\uff1a${formatItems(runtimeSet)}`,
        '\u63d0\u793a\uff1a\u914d\u7f6e\u9ed1\u540d\u5355\u9700\u8981\u5728\u63d2\u4ef6\u914d\u7f6e\u4e2d\u4fee\u6539\uff0c\u52a8\u6001\u9ed1\u540d\u5355\u53ef\u7528\u672c\u547d\u4ee4\u7ba1\u7406\u3002',
      ].join('\n')
    }

    if (['list', 'ls', '\u67e5\u770b', '\u5217\u8868'].includes(actionLower)) {
      return [
        this.timeLine(),
        '\ud83e\uddfe Apex \u9ed1\u540d\u5355\u5217\u8868',
        `\u914d\u7f6e\u9ed1\u540d\u5355\uff1a${formatItems(this.configBlacklist)}`,
        `\u52a8\u6001\u9ed1\u540d\u5355\uff1a${formatItems(runtimeSet)}`,
      ].join('\n')
    }

    if (['clear', '\u6e05\u7a7a', 'clean'].includes(actionLower)) {
      if (!runtimeSet.size) return [this.timeLine(), '\u2139\ufe0f \u52a8\u6001\u9ed1\u540d\u5355\u5df2\u4e3a\u7a7a\u3002'].join('\n')
      this.settings.runtimeBlacklist = []
      await this.saveSettings()
      return [this.timeLine(), '\u2705 \u5df2\u6e05\u7a7a\u52a8\u6001\u9ed1\u540d\u5355\u3002'].join('\n')
    }

    const items = this.splitBlacklistItems(input)
    if (!items.length) {
      return [this.timeLine(), '\u26a0\ufe0f \u8bf7\u63d0\u4f9b\u73a9\u5bb6 ID\uff0c\u4f8b\u5982\uff1a/apexblacklist add moeneri'].join('\n')
    }

    if (['add', '+', '\u65b0\u589e', '\u6dfb\u52a0', '\u52a0\u5165'].includes(actionLower)) {
      const added: string[] = []
      const existedConfig: string[] = []
      const existedRuntime: string[] = []
      for (const item of items) {
        const normalized = normalizeLookupValue(item)
        if (!normalized) continue
        if (this.configBlacklist.has(normalized)) existedConfig.push(normalized)
        else if (runtimeSet.has(normalized)) existedRuntime.push(normalized)
        else {
          runtimeSet.add(normalized)
          added.push(normalized)
        }
      }
      this.settings.runtimeBlacklist = Array.from(runtimeSet)
      if (added.length) await this.saveSettings()
      return [
        this.timeLine(),
        `\u2705 \u5df2\u6dfb\u52a0 ${added.length} \u4e2a\u52a8\u6001\u9ed1\u540d\u5355 ID\u3002`,
        added.length ? `\u65b0\u589e\uff1a${formatItems(added)}` : '',
        existedConfig.length ? `\u5df2\u5728\u914d\u7f6e\u9ed1\u540d\u5355\uff1a${formatItems(existedConfig)}` : '',
        existedRuntime.length ? `\u5df2\u5728\u52a8\u6001\u9ed1\u540d\u5355\uff1a${formatItems(existedRuntime)}` : '',
      ].filter(Boolean).join('\n')
    }

    if (['remove', 'del', 'delete', 'rm', '-', '\u79fb\u9664', '\u5220\u9664'].includes(actionLower)) {
      const removed: string[] = []
      const inConfig: string[] = []
      const notFound: string[] = []
      for (const item of items) {
        const normalized = normalizeLookupValue(item)
        if (!normalized) continue
        if (runtimeSet.delete(normalized)) removed.push(normalized)
        else if (this.configBlacklist.has(normalized)) inConfig.push(normalized)
        else notFound.push(normalized)
      }
      this.settings.runtimeBlacklist = Array.from(runtimeSet)
      if (removed.length) await this.saveSettings()
      return [
        this.timeLine(),
        `\u2705 \u5df2\u79fb\u9664 ${removed.length} \u4e2a\u52a8\u6001\u9ed1\u540d\u5355 ID\u3002`,
        removed.length ? `\u79fb\u9664\uff1a${formatItems(removed)}` : '',
        inConfig.length ? `\u914d\u7f6e\u9ed1\u540d\u5355\u9700\u5728\u914d\u7f6e\u4e2d\u5220\u9664\uff1a${formatItems(inConfig)}` : '',
        notFound.length ? `\u672a\u627e\u5230\uff1a${formatItems(notFound)}` : '',
      ].filter(Boolean).join('\n')
    }

    return [this.timeLine(), '\u26a0\ufe0f \u672a\u8bc6\u522b\u7684\u64cd\u4f5c\uff0c\u8bf7\u4f7f\u7528 add/remove/list/clear\u3002'].join('\n')
  }

  private async pollOnce() {
    if (!this.config.apiKey) return
    for (const [groupId, group] of this.groupStore.entries()) {
      for (const [playerKey, player] of Object.entries(group.players)) {
        await this.pollPlayer(groupId, group, playerKey, player)
      }
    }
  }

  private async pollPlayer(groupId: string, group: StoredGroupRecord, playerKey: string, player: StoredPlayerRecord) {
    if (this.isBlacklisted(player.playerName) || this.isQueryBlocked(player.playerName)) {
      this.logger.warn(`skip blacklisted player: ${player.playerName}`)
      return
    }

    try {
      const { player: playerData } = await this.api.fetchPlayerStatsAuto(player.lookupId || player.playerName, player.platform || 'PC', Boolean(player.useUid))
      const oldScore = player.rankScore
      const newScore = playerData.rankScore
      const validScore = newScore >= this.config.minValidScore
      const abnormalDrop = isScoreDropAbnormal(oldScore, newScore)
      const seasonReset = isLikelySeasonReset(oldScore, newScore)

      if (!validScore) {
        this.logger.warn(`invalid score for ${player.playerName}: ${newScore}`)
        return
      }
      if (abnormalDrop) {
        this.logger.warn(`abnormal score drop for ${player.playerName}: ${oldScore} -> ${newScore}`)
        return
      }
      if (newScore === oldScore) return

      group.players[playerKey] = {
        ...player,
        playerName: playerData.name,
        rankScore: newScore,
        rankName: playerData.rankName,
        rankDiv: playerData.rankDiv,
        lastChecked: Date.now(),
        globalRankPercent: playerData.globalRankPercent,
        selectedLegend: playerData.selectedLegend,
        legendKillsPercent: playerData.legendKillsRank?.globalPercent || '',
        ownerUserId: player.ownerUserId,
        remark: sanitizeRemark(player.remark),
      }
      await this.groupStore.save()

      const diff = newScore - oldScore
      const diffText = diff > 0 ? `上升 ${diff}` : `下降 ${Math.abs(diff)}`
      const displayName = this.getPlayerDisplayName(player)
      const lines = [
        '📈 Apex 排位分数变化',
        this.timeLine(),
        `\ud83d\udc64 \u73a9\u5bb6: ${displayName}`,
        `\ud83d\udd79\ufe0f \u5e73\u53f0: ${formatPlatform(player.platform)}`,
        `\ud83d\udd22 \u539f\u5206\u6570: ${oldScore}`,
        `\ud83d\udd22 \u5f53\u524d\u5206\u6570: ${newScore}`,
        `\ud83c\udfc6 \u6bb5\u4f4d: ${formatRank(playerData.rankName, playerData.rankDiv)}`,
        `\ud83c\udfaf \u53d8\u52a8: ${diffText} \u5206`,
      ]
      if (seasonReset) lines.push('\u26a0\ufe0f \u68c0\u6d4b\u5230\u5927\u5e45\u5ea6\u5206\u6570\u4e0b\u964d\uff0c\u53ef\u80fd\u662f\u8d5b\u5b63\u91cd\u7f6e\u5bfc\u81f4\u3002')
      if (playerData.globalRankPercent && playerData.globalRankPercent !== '\u672a\u77e5') {
        lines.push(`\ud83c\udf10 \u5168\u7403\u6392\u540d: ${playerData.globalRankPercent}%`)
      }
      if (playerData.selectedLegend) lines.push(`\ud83e\uddb8 \u5f53\u524d\u82f1\u96c4: ${playerData.selectedLegend}`)
      if (playerData.legendKillsRank) lines.push(`\ud83c\udfaf \u51fb\u6740\u6392\u540d: \u5168\u7403 ${playerData.legendKillsRank.globalPercent}%`)
      if (playerData.currentState) lines.push(`\ud83c\udfae \u5f53\u524d\u72b6\u6001: ${playerData.currentState}`)
      const renderPlayer = {
        ...playerData,
        displayName,
      }
      try {
        const imagePath = await this.imageRenderer.renderRankChange(renderPlayer, oldScore, newScore, player.platform, seasonReset)
        await this.sendToTarget(group.target, h.image(imagePath))
      } catch (error) {
        this.logger.error(`rank change image render failed: ${String((error as Error)?.message || error)}`)
        await this.sendToTarget(group.target, lines.join('\n'))
      }
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        this.logger.warn(`player not found during poll: ${groupId}/${player.playerName}`)
        return
      }
      this.logger.error(`poll player failed: ${String((error as Error)?.message || error)}`)
    }
  }

  private formatPlayerRankText(playerData: ApexPlayerStats & { displayName?: string }) {
    const lines = [
      '\ud83d\udcca Apex \u6bb5\u4f4d\u4fe1\u606f',
      this.timeLine(),
      `\ud83d\udc64 \u73a9\u5bb6: ${playerData.displayName || playerData.name}`,
      `\ud83d\udd79\ufe0f \u5e73\u53f0: ${formatPlatform(playerData.platform)}`,
      `\ud83c\udd94 UID: ${playerData.uid || '\u672a\u77e5'}`,
      `\ud83c\udfc6 \u6bb5\u4f4d: ${formatRank(playerData.rankName, playerData.rankDiv)}`,
      `\ud83d\udd22 \u5206\u6570: ${playerData.rankScore}`,
      `\ud83c\udf96\ufe0f \u7b49\u7ea7: ${playerData.level}`,
      `\ud83d\udfe2 \u5728\u7ebf\u72b6\u6001: ${playerData.isOnline ? '\u5728\u7ebf' : '\u79bb\u7ebf'}`,
    ]
    if (playerData.globalRankPercent && playerData.globalRankPercent !== '\u672a\u77e5') lines.push(`\ud83c\udf10 \u5168\u7403\u6392\u540d: ${playerData.globalRankPercent}%`)
    if (playerData.selectedLegend) lines.push(`\ud83e\uddb8 \u5f53\u524d\u82f1\u96c4: ${playerData.selectedLegend}`)
    if (playerData.legendKillsRank) lines.push(`\ud83c\udfaf \u51fb\u6740\u6392\u540d: \u5168\u7403 ${playerData.legendKillsRank.globalPercent}%`)
    if (playerData.currentState) lines.push(`\ud83c\udfae \u5f53\u524d\u72b6\u6001: ${playerData.currentState}`)
    return lines.join('\n')
  }

  private formatSeasonInfo(seasonInfo: { seasonNumber: number | null; seasonName: string; startDate: string; endDate: string; timezone: string; updateTimeHint: string; source: string; startIso: string; endIso: string }) {
    const label = seasonInfo.seasonNumber === null
      ? (seasonInfo.seasonName || '\u672a\u77e5')
      : seasonInfo.seasonName
        ? `S${seasonInfo.seasonNumber} \u00b7 ${seasonInfo.seasonName}`
        : `S${seasonInfo.seasonNumber}`

    const startBj = this.toBeijingTime(seasonInfo.startIso)
    const endBj = this.toBeijingTime(seasonInfo.endIso)
    const lines = [
      this.timeLine(),
      '\ud83d\uddd3\ufe0f Apex \u8d5b\u5b63\u65f6\u95f4\u4fe1\u606f',
      `\ud83d\udccc \u5f53\u524d\u8d5b\u5b63: ${label}`,
    ]
    if (startBj) lines.push(`\ud83d\udfe2 \u5f00\u59cb\u65f6\u95f4\uff08\u5317\u4eac\u65f6\u95f4\uff09: ${startBj}`)
    else if (seasonInfo.startDate && seasonInfo.startDate !== '\u672a\u77e5') lines.push(`\ud83d\udfe2 \u5f00\u59cb\u65f6\u95f4: ${seasonInfo.startDate}`)
    if (endBj) lines.push(`\ud83d\udd34 \u7ed3\u675f\u65f6\u95f4\uff08\u5317\u4eac\u65f6\u95f4\uff09: ${endBj}`)
    else if (seasonInfo.endDate && seasonInfo.endDate !== '\u672a\u77e5') lines.push(`\ud83d\udd34 \u7ed3\u675f\u65f6\u95f4: ${seasonInfo.endDate}`)
    const remaining = this.formatRemaining(seasonInfo.endIso)
    if (remaining) lines.push(`\u23f3 \u5269\u4f59\u65f6\u95f4: ${remaining}`)
    const progress = this.formatProgress(seasonInfo.startIso, seasonInfo.endIso)
    if (progress) lines.push(`\ud83d\udcc8 \u8d5b\u5b63\u8fdb\u5ea6: ${progress}`)
    if (seasonInfo.timezone && seasonInfo.timezone !== '\u672a\u77e5') lines.push(`\ud83c\udf10 \u65f6\u533a\u4fe1\u606f: ${seasonInfo.timezone}`)
    if (seasonInfo.updateTimeHint && seasonInfo.updateTimeHint !== '\u672a\u77e5') lines.push(`\ud83d\udd50 \u5b98\u7f51\u63d0\u793a\u66f4\u65b0\u65f6\u95f4: ${seasonInfo.updateTimeHint}`)
    lines.push(`\u2139\ufe0f \u6570\u636e\u6765\u6e90: ${seasonInfo.source}`)
    lines.push('\u26a0\ufe0f \u7b2c\u4e09\u65b9\u6570\u636e\u4ec5\u4f9b\u53c2\u8003\uff0c\u8bf7\u4ee5\u6e38\u620f\u5185\u5b9e\u9645\u65f6\u95f4\u4e3a\u51c6\u3002')
    return lines.join('\n')
  }

  private toBeijingTime(isoValue: string) {
    if (!isoValue) return ''
    const date = new Date(isoValue)
    if (Number.isNaN(date.getTime())) return ''
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    return formatter.format(date).replace(/\//g, '-')
  }

  private formatRemaining(endIso: string) {
    if (!endIso) return ''
    const end = new Date(endIso).getTime()
    if (!Number.isFinite(end)) return ''
    let diff = end - Date.now()
    if (diff <= 0) return '\u5df2\u7ed3\u675f'
    const day = Math.floor(diff / 86_400_000)
    diff -= day * 86_400_000
    const hour = Math.floor(diff / 3_600_000)
    diff -= hour * 3_600_000
    const minute = Math.floor(diff / 60_000)
    const parts = []
    if (day) parts.push(`${day} \u5929`)
    if (hour) parts.push(`${hour} \u5c0f\u65f6`)
    if (minute || !parts.length) parts.push(`${minute} \u5206\u949f`)
    return parts.join(' ')
  }

  private formatProgress(startIso: string, endIso: string) {
    if (!startIso || !endIso) return ''
    const start = new Date(startIso).getTime()
    const end = new Date(endIso).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return ''
    const progress = Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100))
    return `${progress.toFixed(2)}%`
  }
}
