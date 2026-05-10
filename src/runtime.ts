import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bot, Context, Logger, Session } from 'koishi'
import { ApexApiClient, PlayerNotFoundError } from './api'
import { buildLeaderboard, getLeaderboardWindow } from './leaderboard'
import { ResolvedConfig } from './config'
import { BindingStore, GroupStore, HistoryStore, SettingsStore } from './storage'
import {
  ApexPlayerStats,
  LeaderboardDirection,
  LeaderboardEntry,
  LeaderboardPeriod,
  NotificationTarget,
  RuntimeSettings,
  ScoreChangeEvent,
  SEASON_KEYWORD_COMMAND_BLOCKLIST,
  StoredGroupRecord,
  StoredPlayerRecord,
  UserBindingRecord,
  buildPlayerKey,
  formatItems,
  formatNow,
  formatPlatform,
  formatRank,
  isLikelySeasonReset,
  isScoreDropAbnormal,
  normalizeLookupValue,
  normalizePlatform,
  parseIdentifier,
  splitCsv,
} from './shared'

type CommandSession = Session

export class ApexRankWatchRuntime {
  private readonly logger = new Logger('apexrankwatch')
  private readonly dataDir: string
  private readonly groupsFile: string
  private readonly settingsFile: string
  private readonly bindingsFile: string
  private readonly historyFile: string
  private readonly groupStore: GroupStore
  private readonly settingsStore: SettingsStore
  private readonly bindingStore: BindingStore
  private readonly historyStore: HistoryStore
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
    this.historyFile = resolve(this.dataDir, 'history.json')
    this.groupStore = new GroupStore(this.groupsFile, this.logger)
    this.settingsStore = new SettingsStore(this.settingsFile, this.logger)
    this.bindingStore = new BindingStore(this.bindingsFile, this.logger)
    this.historyStore = new HistoryStore(this.historyFile, this.logger)
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
    this.ready = this.initialize()
  }

  private async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    await this.groupStore.load()
    this.settings = await this.settingsStore.load()
    await this.bindingStore.load()
    await this.historyStore.load()
    this.pruneHistory()
    await this.historyStore.save()
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
      .alias('apex测试')
      .action(this.wrap(async (session) => this.handleTest(session)))

    this.ctx.command('apexhelp', 'show plugin help')
      .alias('apex帮助')
      .alias('apexrankhelp')
      .action(this.wrap(async (session) => this.handleHelp(session)))

    this.ctx.command('apexrank [input:text]', 'query current rank')
      .alias('apex查询')
      .alias('视奸')
      .action(this.wrap(async (session, input = '') => this.handleRankQuery(session, input)))

    this.ctx.command('apexbind [input:text]', 'bind current user to an apex account in this group')
      .alias('apex绑定')
      .action(this.wrap(async (session, input = '') => this.handleBind(session, input)))

    this.ctx.command('apexunbind', 'unbind current user apex account in this group')
      .alias('apex解绑')
      .action(this.wrap(async (session) => this.handleUnbind(session)))

    this.ctx.command('apexscore', 'query bound apex account in current group')
      .alias('apex查分')
      .action(this.wrap(async (session) => this.handleBoundScore(session)))

    this.ctx.command('apexrankwatch [input:text]', 'watch player rank in current group')
      .alias('apex监控')
      .alias('持续视奸')
      .action(this.wrap(async (session, input = '') => this.handleWatch(session, input)))

    this.ctx.command('apexranklist', 'show watch list')
      .alias('apex列表')
      .action(this.wrap(async (session) => this.handleList(session)))

    this.ctx.command('apexremark <player> [remark:text]', 'set a remark for a watched player')
      .alias('apex备注')
      .action(this.wrap(async (session, player, remark) => this.handleRemark(session, player || '', remark || '')))

    this.ctx.command('apexrankremove [input:text]', 'remove a watch target')
      .alias('apex移除')
      .alias('取消持续视奸')
      .action(this.wrap(async (session, input = '') => this.handleRemove(session, input)))

    this.ctx.command('apexpredator', 'query predator threshold')
      .alias('apex猎杀')
      .action(this.wrap(async (session) => this.handlePredator(session)))

    this.ctx.command('apexseason', 'query current season time')
      .alias('apex赛季')
      .alias('新赛季')
      .action(this.wrap(async (session) => this.handleSeason(session)))

    this.ctx.command('apexdayup', 'show daily rank gain leaderboard')
      .alias('apex日上分榜')
      .action(this.wrap(async (session) => this.handleLeaderboard(session, 'day', 'up')))

    this.ctx.command('apexdaydown', 'show daily rank loss leaderboard')
      .alias('apex日掉分榜')
      .action(this.wrap(async (session) => this.handleLeaderboard(session, 'day', 'down')))

    this.ctx.command('apexweekup', 'show weekly rank gain leaderboard')
      .alias('apex周上分榜')
      .action(this.wrap(async (session) => this.handleLeaderboard(session, 'week', 'up')))

    this.ctx.command('apexweekdown', 'show weekly rank loss leaderboard')
      .alias('apex周掉分榜')
      .action(this.wrap(async (session) => this.handleLeaderboard(session, 'week', 'down')))

    this.ctx.command('apexblacklist [action:string] [input:text]', 'manage runtime blacklist')
      .alias('apex黑名单')
      .alias('不准视奸')
      .alias('apexban')
      .action(this.wrap(async (session, action = '', input = '') => this.handleBlacklist(session, action, input)))

    this.ctx.command('赛季关闭', 'disable season keyword reply in this group')
      .action(this.wrap(async (session) => this.handleSeasonKeywordToggle(session, true)))

    this.ctx.command('赛季开启', 'enable season keyword reply in this group')
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
      if (!raw || raw.startsWith('/') || raw.startsWith('／')) return

      const first = raw.split(/\s+/, 1)[0].replace(/^[/／]+/, '').trim().toLowerCase()
      if (first && SEASON_KEYWORD_COMMAND_BLOCKLIST.has(first)) return
      if (!raw.includes('赛季')) return

      const groupId = this.getGroupId(session)
      if (groupId && this.isSeasonKeywordDisabled(groupId)) return
      if (this.guardAccess(session)) return

      try {
        const seasonInfo = await this.api.fetchCurrentSeasonInfo()
        const suffix = groupId ? '\n🔕 关闭赛季关键词回复：/赛季关闭' : ''
        return `${this.formatSeasonInfo(seasonInfo)}${suffix}`
      } catch (error: any) {
        this.logger.error(`season query failed: ${error?.message || error}`)
      }
    })
  }

  private wrap<T extends any[]>(handler: (session: CommandSession, ...args: T) => Promise<string | void>) {
    return async ({ session }: { session?: CommandSession }, ...args: T) => {
      if (!session) return ''
      await this.ready
      return handler(session, ...args)
    }
  }

  private timeLine() {
    return `🕒 时间: ${formatNow()}`
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

  private async sendToTarget(target: NotificationTarget | null, message: string) {
    if (!target?.channelId) {
      this.logger.warn('notification target is missing')
      return false
    }

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
        if (typeof bot.internal?.sendGroupMsg === 'function') {
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
    return '⚠️ 此命令仅管理员可用，请在配置中设置 ownerQq 或使用群管理员账号执行。'
  }

  private guardAccess(session: CommandSession, requireGroup = false) {
    const userId = this.getUserId(session)
    if (this.isOwner(userId)) return ''
    if (userId && this.userBlacklist.has(userId)) {
      return '⛔ 你已被禁止使用此插件。'
    }

    const groupId = this.getGroupId(session)
    if (requireGroup && !groupId) {
      return '⚠️ 此命令仅适用于群聊，请在群聊中使用。'
    }
    if (!groupId && !this.config.allowPrivate) {
      return '⚠️ 当前不允许私聊使用，请在群聊中使用。'
    }
    if (groupId && this.config.whitelistEnabled && !this.whitelistGroups.has(groupId)) {
      return '⚠️ 本群未在白名单中，无法使用此插件。'
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
    return Array.from(new Set(String(input || '').replace(/，/g, ',').split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)))
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

  private createBindingRecord(groupId: string, userId: string, lookupId: string, useUid: boolean, platform: string, player: ApexPlayerStats): UserBindingRecord {
    return {
      groupId,
      userId,
      lookupId,
      useUid,
      platform: normalizePlatform(platform),
      playerName: player.name,
      uid: player.uid,
      updatedAt: Date.now(),
    }
  }

  private createScoreChangeEvent(groupId: string, playerKey: string, playerData: ApexPlayerStats, oldScore: number, newScore: number): ScoreChangeEvent {
    return {
      groupId,
      playerKey,
      playerName: playerData.name,
      platform: normalizePlatform(playerData.platform),
      oldScore,
      newScore,
      delta: newScore - oldScore,
      observedAt: Date.now(),
    }
  }

  private formatDisplayPlayerName(playerName: string, remark?: string) {
    return remark ? `${remark} (${playerName})` : playerName
  }

  private historyRetentionDays() {
    return 35
  }

  private pruneHistory() {
    const retentionMs = this.historyRetentionDays() * 86_400_000
    this.historyStore.pruneOlderThan(Date.now() - retentionMs)
  }

  private formatLeaderboardPeriodLabel(period: LeaderboardPeriod) {
    return period === 'day' ? '每日' : '每周'
  }

  private formatLeaderboardWindowLabel(period: LeaderboardPeriod, now = new Date()) {
    const { startAt } = getLeaderboardWindow(period, now)
    const start = this.toBeijingTime(new Date(startAt).toISOString())
    const end = this.toBeijingTime(now.toISOString())
    return `${start} - ${end}`
  }

  private formatLeaderboardText(group: StoredGroupRecord, entries: LeaderboardEntry[], period: LeaderboardPeriod, direction: LeaderboardDirection, now = new Date()) {
    const periodLabel = this.formatLeaderboardPeriodLabel(period)
    const directionLabel = direction === 'up' ? '上分榜' : '掉分榜'
    if (!entries.length) {
      return [
        this.timeLine(),
        `ℹ️ 本群当前${periodLabel}${directionLabel}暂无有效记录。`,
        `📅 统计范围: ${this.formatLeaderboardWindowLabel(period, now)}`,
      ].join('\n')
    }

    const lines = [
      this.timeLine(),
      `📊 本群 Apex ${periodLabel}${directionLabel}`,
      `📅 统计范围: ${this.formatLeaderboardWindowLabel(period, now)}`,
    ]
    entries.slice(0, 10).forEach((entry, index) => {
      const player = group.players[entry.playerKey]
      const displayName = this.formatDisplayPlayerName(entry.playerName, player?.remark)
      const deltaText = entry.netDelta > 0 ? `+${entry.netDelta}` : `${entry.netDelta}`
      lines.push(`${index + 1}. ${displayName} | ${formatPlatform(entry.platform)} | ${deltaText} | ${entry.changeCount} 次变化 | 当前 ${entry.currentScore}`)
    })
    return lines.join('\n')
  }

  private async migrateStoreKeys() {
    let changed = false
    for (const [groupId, group] of this.groupStore.entries()) {
      const nextPlayers: Record<string, StoredPlayerRecord> = {}
      for (const record of Object.values(group.players)) {
        const platform = normalizePlatform(record.platform || 'PC')
        const lookupId = record.lookupId || record.playerName
        const useUid = Boolean(record.useUid)
        const key = buildPlayerKey(lookupId, platform, useUid)
        nextPlayers[key] = { ...record, platform, lookupId, useUid }
        if (key !== buildPlayerKey(record.lookupId || record.playerName, record.platform || 'PC', Boolean(record.useUid))) {
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
      '⚠️ 请先在插件配置中填写 API Key。',
      `🔗 Key 申请地址: ${this.apiKeyApplyUrl()}`,
    ].join('\n')
  }

  private apiRequestFailedText(action = '查询') {
    return [
      this.timeLine(),
      `❌ ${action}失败：请检查网络、API Key 是否有效，或稍后再试。`,
      `🔗 Key 申请地址: ${this.apiKeyApplyUrl()}`,
    ].join('\n')
  }

  private async handleTest(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    const target = this.extractTarget(session)
    if (!target) {
      return [this.timeLine(), '✅ Apex Legends 排名监控插件正常运行中。'].join('\n')
    }

    const success = await this.sendToTarget(target, '✅ Apex Legends 排名监控测试消息')
    if (success) {
      return [this.timeLine(), '✅ Apex Legends 排名监控插件正常运行中，测试消息已发送到当前会话。'].join('\n')
    }
    return [this.timeLine(), '⚠️ 指令可用，但当前平台或适配器不支持主动消息推送。'].join('\n')
  }

  private async handleHelp(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    const lines = [
      this.timeLine(),
      '📖 Apex Rank Watch 帮助',
      '【查询】',
      '/apexrank <玩家|uid:...> [平台]  别名：/apex查询 /视奸',
      '示例：/apexrank moeneri pc',
      '【绑定（群聊）】',
      '/apexbind <玩家|uid:...> [平台]  别名：/apex绑定',
      '/apexunbind  别名：/apex解绑',
      '/apexscore  别名：/apex查分',
      '【监控（群聊）】',
      '/apexrankwatch <玩家|uid:...> [平台]  别名：/apex监控 /持续视奸',
      '/apexranklist  别名：/apex列表',
      '/apexrankremove <玩家|uid:...> [平台]  别名：/apex移除 /取消持续视奸',
      '/apexdayup  别名：/apex日上分榜',
      '/apexdaydown  别名：/apex日掉分榜',
      '/apexweekup  别名：/apex周上分榜',
      '/apexweekdown  别名：/apex周掉分榜',
      '【信息】',
      '/apexpredator  别名：/apex猎杀',
      '/apexseason  别名：/apex赛季 /新赛季',
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

  private async handleRankQuery(session: CommandSession, input: string) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    const { playerName, platform } = this.parsePlayerPlatformInput(input)
    if (!playerName) {
      return [this.timeLine(), '⚠️ 请提供玩家名称，例如：/apexrank moeneri'].join('\n')
    }
    if (this.isBlacklisted(playerName) || this.isQueryBlocked(playerName)) {
      return [this.timeLine(), `⛔ 该 ID（${playerName}）已被管理员加入黑名单，禁止查询。`].join('\n')
    }
    if (!this.config.apiKey) return this.missingApiKeyText()

    const { identifier, useUid } = parseIdentifier(playerName)
    if (!identifier) {
      return [this.timeLine(), '⚠️ 请提供有效的玩家名称或 UID。'].join('\n')
    }

    try {
      const { player, platform: usedPlatform } = await this.api.fetchPlayerStatsAuto(identifier, platform, useUid)
      if (player.rankScore < this.config.minValidScore) {
        return [this.timeLine(), `⚠️ 查询到 ${playerName} 的分数为 ${player.rankScore}，低于最低有效分数 ${this.config.minValidScore}，可能是 API 异常，请稍后再试。`].join('\n')
      }
      player.platform = usedPlatform
      return this.formatPlayerRankText(player)
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        return [this.timeLine(), '⚠️ 未找到该玩家，请检查名称是否正确，或在命令末尾指定平台。'].join('\n')
      }
      this.logger.error(`rank query failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('查询')
    }
  }

  private async handleBind(session: CommandSession, input: string) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const { playerName, platform } = this.parsePlayerPlatformInput(input)
    if (!playerName) {
      return [this.timeLine(), '⚠️ 请提供要绑定的玩家名称或 UID，例如：/apexbind moeneri 或 /apexbind uid:123456'].join('\n')
    }

    const groupId = this.getGroupId(session)
    const userId = this.getUserId(session)
    if (!groupId) {
      return [this.timeLine(), '⚠️ 此命令仅适用于群聊，请在群聊中使用。'].join('\n')
    }
    if (!userId) {
      return [this.timeLine(), '⚠️ 无法识别当前用户，请稍后重试。'].join('\n')
    }
    if (this.isBlacklisted(playerName) || this.isQueryBlocked(playerName)) {
      return [this.timeLine(), `⛔ 该 ID（${playerName}）已被管理员加入黑名单，禁止绑定。`].join('\n')
    }
    if (!this.config.apiKey) return this.missingApiKeyText()

    const { identifier, useUid } = parseIdentifier(playerName)
    if (!identifier) {
      return [this.timeLine(), '⚠️ 请提供有效的玩家名称或 UID。'].join('\n')
    }

    try {
      const { player, platform: usedPlatform } = await this.api.fetchPlayerStatsAuto(identifier, platform, useUid)
      if (player.rankScore < this.config.minValidScore) {
        return [this.timeLine(), `⚠️ 查询到 ${playerName} 的分数为 ${player.rankScore}，低于最低有效分数 ${this.config.minValidScore}，可能是 API 异常，请稍后再试。`].join('\n')
      }

      const normalizedPlatform = normalizePlatform(usedPlatform)
      const existing = this.bindingStore.getBinding(groupId, userId)
      this.bindingStore.setBinding(groupId, userId, this.createBindingRecord(groupId, userId, identifier, useUid, normalizedPlatform, player))
      await this.bindingStore.save()

      return [
        this.timeLine(),
        existing ? '✅ 已更新你在本群绑定的 Apex 账号。' : '✅ 已绑定你在本群的 Apex 账号。',
        `👤 玩家: ${player.name}`,
        `🕹️ 平台: ${formatPlatform(normalizedPlatform)}`,
        `🆔 UID: ${player.uid || '未知'}`,
        `🏆 当前段位: ${formatRank(player.rankName, player.rankDiv)} (${player.rankScore} 分)`,
      ].join('\n')
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        return [this.timeLine(), '⚠️ 未找到该玩家，请检查名称是否正确，或在命令末尾指定平台。'].join('\n')
      }
      this.logger.error(`bind failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('绑定')
    }
  }

  private async handleUnbind(session: CommandSession) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const groupId = this.getGroupId(session)
    const userId = this.getUserId(session)
    if (!groupId) {
      return [this.timeLine(), '⚠️ 此命令仅适用于群聊，请在群聊中使用。'].join('\n')
    }
    if (!userId) {
      return [this.timeLine(), '⚠️ 无法识别当前用户，请稍后重试。'].join('\n')
    }

    const binding = this.bindingStore.getBinding(groupId, userId)
    if (!binding) {
      return [this.timeLine(), 'ℹ️ 你当前还没有在本群绑定 Apex 账号。'].join('\n')
    }

    this.bindingStore.removeBinding(groupId, userId)
    await this.bindingStore.save()
    return [this.timeLine(), `✅ 已解绑你在本群绑定的 Apex 账号：${binding.playerName}`].join('\n')
  }

  private async handleBoundScore(session: CommandSession) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const groupId = this.getGroupId(session)
    const userId = this.getUserId(session)
    if (!groupId) {
      return [this.timeLine(), '⚠️ 此命令仅适用于群聊，请在群聊中使用。'].join('\n')
    }
    if (!userId) {
      return [this.timeLine(), '⚠️ 无法识别当前用户，请稍后重试。'].join('\n')
    }

    const binding = this.bindingStore.getBinding(groupId, userId)
    if (!binding) {
      return [
        this.timeLine(),
        'ℹ️ 你当前还没有在本群绑定 Apex 账号。',
        '请先使用 /apexbind <玩家名|uid:...> [平台] 进行绑定。',
      ].join('\n')
    }

    const bindingLookupText = binding.useUid ? `uid:${binding.lookupId}` : binding.lookupId
    if (this.isBlacklisted(bindingLookupText) || this.isQueryBlocked(bindingLookupText)) {
      return [this.timeLine(), `⛔ 你绑定的账号（${binding.playerName || bindingLookupText}）已被管理员加入黑名单，无法查询。`].join('\n')
    }
    if (!this.config.apiKey) return this.missingApiKeyText()

    try {
      const { player, platform: usedPlatform } = await this.api.fetchPlayerStatsAuto(binding.lookupId, binding.platform, binding.useUid)
      if (player.rankScore < this.config.minValidScore) {
        return [this.timeLine(), `⚠️ 查询到 ${binding.playerName || bindingLookupText} 的分数为 ${player.rankScore}，低于最低有效分数 ${this.config.minValidScore}，可能是 API 异常，请稍后再试。`].join('\n')
      }

      const normalizedPlatform = normalizePlatform(usedPlatform)
      player.platform = normalizedPlatform
      this.bindingStore.setBinding(groupId, userId, {
        ...binding,
        platform: normalizedPlatform,
        playerName: player.name,
        uid: player.uid,
        updatedAt: Date.now(),
      })
      await this.bindingStore.save()
      return this.formatPlayerRankText(player)
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        return [this.timeLine(), '⚠️ 当前绑定账号暂时无法查询，请检查绑定信息是否正确，或重新绑定后再试。'].join('\n')
      }
      this.logger.error(`bound score query failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('查分')
    }
  }

  private async handlePredator(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')
    if (!this.config.apiKey) return this.missingApiKeyText()

    try {
      const predatorInfo = await this.api.fetchPredatorInfo()
      if (!predatorInfo.platforms.length) {
        return [this.timeLine(), '⚠️ 暂未获取到猎杀门槛数据。'].join('\n')
      }
      const lines = [this.timeLine(), '🏹 Apex 猎杀门槛与大师及以上人数']
      lines.push(`🎮 模式: ${predatorInfo.mode === 'RP' ? '排位积分 (RP)' : predatorInfo.mode}`)
      for (const entry of predatorInfo.platforms) {
        lines.push(`🎯 ${formatPlatform(entry.platform)}: 猎杀门槛 ${entry.requiredRp ?? '未知'}，大师及以上人数 ${entry.mastersCount ?? '未知'}`)
      }
      return lines.join('\n')
    } catch (error) {
      this.logger.error(`predator query failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('查询')
    }
  }

  private async handleSeason(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    try {
      return this.formatSeasonInfo(await this.api.fetchCurrentSeasonInfo())
    } catch (error) {
      this.logger.error(`season query failed: ${String((error as Error)?.message || error)}`)
      return [this.timeLine(), '❌ 查询失败：无法获取赛季时间信息。'].join('\n')
    }
  }

  private async handleLeaderboard(session: CommandSession, period: LeaderboardPeriod, direction: LeaderboardDirection) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const groupId = this.getGroupId(session)
    if (!groupId) {
      return [this.timeLine(), '⚠️ 此命令仅适用于群聊，请在群聊中使用。'].join('\n')
    }

    const group = this.groupStore.getGroup(groupId)
    if (!group || !Object.keys(group.players).length) {
      return [this.timeLine(), 'ℹ️ 本群目前没有监控任何玩家，无法生成榜单。'].join('\n')
    }

    const entries = buildLeaderboard(this.historyStore.getGroupEvents(groupId), group.players, direction, period)
    return this.formatLeaderboardText(group, entries, period, direction)
  }

  private async handleSeasonKeywordToggle(session: CommandSession, disabled: boolean) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')
    const adminDeny = this.guardAdmin(session)
    if (adminDeny) return [this.timeLine(), adminDeny].join('\n')

    const groupId = this.getGroupId(session)
    if (!groupId) {
      return [this.timeLine(), '⚠️ 此命令仅适用于群聊，请在群聊中使用。'].join('\n')
    }

    const set = new Set(this.settings.seasonKeywordDisabledGroups)
    if (disabled) set.add(groupId)
    else set.delete(groupId)
    this.settings.seasonKeywordDisabledGroups = Array.from(set)
    await this.saveSettings()

    return [this.timeLine(), disabled ? '🔕 已关闭本群赛季关键词自动回复。' : '✅ 已开启本群赛季关键词自动回复。'].join('\n')
  }

  private async handleWatch(session: CommandSession, input: string) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const { playerName, platform } = this.parsePlayerPlatformInput(input)
    if (!playerName) {
      return [this.timeLine(), '⚠️ 请提供要监控的玩家名称，例如：/apexrankwatch moeneri'].join('\n')
    }

    const groupId = this.getGroupId(session)
    const target = this.extractTarget(session)
    if (!groupId || !target) {
      return [this.timeLine(), '⚠️ 当前会话无法识别群聊目标，请稍后重试。'].join('\n')
    }
    if (this.isBlacklisted(playerName) || this.isQueryBlocked(playerName)) {
      return [this.timeLine(), `⛔ 该 ID（${playerName}）已被管理员加入黑名单，禁止监控。`].join('\n')
    }
    if (!this.config.apiKey) return this.missingApiKeyText()

    const { identifier, useUid } = parseIdentifier(playerName)
    if (!identifier) {
      return [this.timeLine(), '⚠️ 请提供有效的玩家名称或 UID。'].join('\n')
    }

    try {
      const { player, platform: usedPlatform } = await this.api.fetchPlayerStatsAuto(identifier, platform, useUid)
      if (player.rankScore < this.config.minValidScore) {
        return [this.timeLine(), `⚠️ 查询到 ${playerName} 的分数为 ${player.rankScore}，低于最低有效分数 ${this.config.minValidScore}，可能是 API 异常，请稍后再试。`].join('\n')
      }

      const normalizedPlatform = normalizePlatform(usedPlatform)
      const playerKey = buildPlayerKey(identifier, normalizedPlatform, useUid)
      const group = this.groupStore.ensureGroup(groupId, target)
      if (group.players[playerKey]) {
        return [this.timeLine(), `ℹ️ 本群已经在监控 ${player.name} 的排名变化。`].join('\n')
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
      }, target)
      await this.groupStore.save()

      await this.sendToTarget(target, `✅ 测试消息：已添加对 ${player.name} 的排名监控。`)
      return [
        this.timeLine(),
        `✅ 成功添加对 ${player.name} 的排名监控。`,
        `🕹️ 平台: ${formatPlatform(normalizedPlatform)}`,
        `🏆 当前段位: ${formatRank(player.rankName, player.rankDiv)} (${player.rankScore} 分)`,
      ].join('\n')
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        return [this.timeLine(), '⚠️ 未找到该玩家，请检查名称是否正确，或在命令末尾指定平台。'].join('\n')
      }
      this.logger.error(`watch add failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('添加监控')
    }
  }

  private async handleList(session: CommandSession) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const groupId = this.getGroupId(session)
    const target = this.extractTarget(session)
    if (!groupId) {
      return [this.timeLine(), '⚠️ 此命令仅适用于群聊，请在群聊中使用。'].join('\n')
    }
    if (target) this.groupStore.updateTarget(groupId, target)

    const group = this.groupStore.getGroup(groupId)
    if (!group || !Object.keys(group.players).length) {
      return [this.timeLine(), 'ℹ️ 本群目前没有监控任何玩家。'].join('\n')
    }

    const lines = [this.timeLine(), '📋 本群 Apex 排名监控列表']
    let index = 0
    for (const player of Object.values(group.players)) {
      index += 1
      const displayName = this.formatDisplayPlayerName(player.playerName, player.remark)
      lines.push(`👤 玩家 ${index}: ${displayName}`)
      lines.push(`🕹️ 平台: ${formatPlatform(player.platform)}`)
      lines.push(`🏆 段位: ${formatRank(player.rankName, player.rankDiv)}`)
      lines.push(`🔢 分数: ${player.rankScore}`)
      if (player.globalRankPercent && player.globalRankPercent !== '未知') {
        lines.push(`🌐 全球排名: ${player.globalRankPercent}%`)
      }
      if (player.selectedLegend) lines.push(`🦸 当前英雄: ${player.selectedLegend}`)
      if (player.legendKillsPercent) lines.push(`🎯 击杀排名: 全球 ${player.legendKillsPercent}%`)
      lines.push('---')
    }
    lines.push(`📌 总计: ${Object.keys(group.players).length} 个玩家`)
    lines.push(`⏱️ 检测间隔: ${this.config.checkInterval} 分钟`)
    lines.push(`🎯 最低有效分数: ${this.config.minValidScore} 分`)
    return lines.join('\n')
  }

  private async handleRemark(session: CommandSession, playerInput: string, remark: string) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const { playerName, platform } = this.parsePlayerPlatformInput(playerInput)
    if (!playerName) {
      return [this.timeLine(), '⚠️ 请提供要备注的玩家名称或 UID，例如：/apexremark moeneri 大佬'].join('\n')
    }

    const groupId = this.getGroupId(session)
    const target = this.extractTarget(session)
    if (!groupId) {
      return [this.timeLine(), '⚠️ 此命令仅适用于群聊，请在群聊中使用。'].join('\n')
    }
    if (target) this.groupStore.updateTarget(groupId, target)

    const group = this.groupStore.getGroup(groupId)
    if (!group || !Object.keys(group.players).length) {
      return [this.timeLine(), 'ℹ️ 本群目前没有监控任何玩家。'].join('\n')
    }

    const { identifier, useUid } = parseIdentifier(playerName)
    const playerKey = this.findPlayerKey(group, identifier, platform, useUid)
    if (playerKey === '__MULTI__') {
      return [this.timeLine(), '⚠️ 检测到同名多平台监控，请指定平台，例如：/apexremark moeneri pc 大佬'].join('\n')
    }
    if (!playerKey) {
      return [this.timeLine(), `⚠️ 本群没有监控 ${playerName}，无法设置备注。`].join('\n')
    }

    const record = group.players[playerKey]
    const displayName = this.formatDisplayPlayerName(record.playerName, record.remark)
    if (remark) {
      record.remark = remark
      await this.groupStore.save()
      return [this.timeLine(), `✅ 已将 ${this.formatDisplayPlayerName(record.playerName, remark)} 的备注设置为 ${remark}。`].join('\n')
    } else {
      record.remark = undefined
      await this.groupStore.save()
      return [this.timeLine(), `✅ 已清除 ${displayName} 的备注。`].join('\n')
    }
  }

  private async handleRemove(session: CommandSession, input: string) {
    const deny = this.guardAccess(session, true)
    if (deny) return [this.timeLine(), deny].join('\n')

    const { playerName, platform } = this.parsePlayerPlatformInput(input)
    if (!playerName) {
      return [this.timeLine(), '⚠️ 请提供要移除监控的玩家名称，例如：/apexrankremove moeneri'].join('\n')
    }

    const groupId = this.getGroupId(session)
    const target = this.extractTarget(session)
    if (!groupId) {
      return [this.timeLine(), '⚠️ 此命令仅适用于群聊，请在群聊中使用。'].join('\n')
    }
    if (target) this.groupStore.updateTarget(groupId, target)

    const { identifier, useUid } = parseIdentifier(playerName)
    if (!identifier) {
      return [this.timeLine(), '⚠️ 请提供有效的玩家名称或 UID。'].join('\n')
    }

    const group = this.groupStore.getGroup(groupId)
    if (!group) return [this.timeLine(), `ℹ️ 本群没有监控 ${playerName}。`].join('\n')

    const lookupName = useUid ? `uid:${identifier}` : identifier
    const playerKey = this.findPlayerKey(group, lookupName, platform, useUid)
    if (playerKey === '__MULTI__') {
      return [this.timeLine(), '⚠️ 检测到同名多平台监控，请指定平台，例如：/apexrankremove moeneri pc'].join('\n')
    }
    if (!playerKey || !this.groupStore.removePlayer(groupId, playerKey)) {
      return [this.timeLine(), `ℹ️ 本群没有监控 ${playerName}。`].join('\n')
    }

    await this.groupStore.save()
    return [this.timeLine(), `✅ 已移除本群对 ${playerName} 的排名监控。`].join('\n')
  }

  private async handleBlacklist(session: CommandSession, action: string, input: string) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')
    const adminDeny = this.guardAdmin(session)
    if (adminDeny) return [this.timeLine(), adminDeny].join('\n')

    const runtimeSet = new Set(this.settings.runtimeBlacklist)
    const actionLower = String(action || '').trim().toLowerCase()

    if (!actionLower || ['help', '?', 'h', '帮助'].includes(actionLower)) {
      return [
        this.timeLine(),
        '🧾 Apex 黑名单管理（管理员）',
        '用法：/apexblacklist add <玩家ID>',
        '用法：/apexblacklist remove <玩家ID>',
        '用法：/apexblacklist list',
        '用法：/apexblacklist clear',
        `配置黑名单：${formatItems(this.configBlacklist)}`,
        `动态黑名单：${formatItems(runtimeSet)}`,
        '提示：配置黑名单需要在插件配置中修改，动态黑名单可用本命令管理。',
      ].join('\n')
    }

    if (['list', 'ls', '查看', '列表'].includes(actionLower)) {
      return [
        this.timeLine(),
        '🧾 Apex 黑名单列表',
        `配置黑名单：${formatItems(this.configBlacklist)}`,
        `动态黑名单：${formatItems(runtimeSet)}`,
      ].join('\n')
    }

    if (['clear', '清空', 'clean'].includes(actionLower)) {
      if (!runtimeSet.size) return [this.timeLine(), 'ℹ️ 动态黑名单已为空。'].join('\n')
      this.settings.runtimeBlacklist = []
      await this.saveSettings()
      return [this.timeLine(), '✅ 已清空动态黑名单。'].join('\n')
    }

    const items = this.splitBlacklistItems(input)
    if (!items.length) {
      return [this.timeLine(), '⚠️ 请提供玩家 ID，例如：/apexblacklist add moeneri'].join('\n')
    }

    if (['add', '+', '新增', '添加', '加入'].includes(actionLower)) {
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
        `✅ 已添加 ${added.length} 个动态黑名单 ID。`,
        added.length ? `新增：${formatItems(added)}` : '',
        existedConfig.length ? `已在配置黑名单：${formatItems(existedConfig)}` : '',
        existedRuntime.length ? `已在动态黑名单：${formatItems(existedRuntime)}` : '',
      ].filter(Boolean).join('\n')
    }

    if (['remove', 'del', 'delete', 'rm', '-', '移除', '删除'].includes(actionLower)) {
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
        `✅ 已移除 ${removed.length} 个动态黑名单 ID。`,
        removed.length ? `移除：${formatItems(removed)}` : '',
        inConfig.length ? `配置黑名单需在配置中删除：${formatItems(inConfig)}` : '',
        notFound.length ? `未找到：${formatItems(notFound)}` : '',
      ].filter(Boolean).join('\n')
    }

    return [this.timeLine(), '⚠️ 未识别的操作，请使用 add/remove/list/clear。'].join('\n')
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

      playerData.platform = normalizePlatform(playerData.platform || player.platform)
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
      }
      await this.groupStore.save()

      if (!seasonReset) {
        this.historyStore.appendEvent(groupId, this.createScoreChangeEvent(groupId, playerKey, playerData, oldScore, newScore))
        this.pruneHistory()
        await this.historyStore.save()
      }

      const diff = newScore - oldScore
      const diffText = diff > 0 ? `上升 ${diff}` : `下降 ${Math.abs(diff)}`
      const displayName = this.formatDisplayPlayerName(playerData.name, player.remark)
      const lines = [
        '📈 Apex 排位分数变化',
        this.timeLine(),
        `👤 玩家: ${displayName}`,
        `🕹️ 平台: ${formatPlatform(player.platform)}`,
        `🔢 原分数: ${oldScore}`,
        `🔢 当前分数: ${newScore}`,
        `🏆 段位: ${formatRank(playerData.rankName, playerData.rankDiv)}`,
        `🎯 变动: ${diffText} 分`,
      ]
      if (seasonReset) lines.push('⚠️ 检测到大幅度分数下降，可能是赛季重置导致。')
      if (playerData.globalRankPercent && playerData.globalRankPercent !== '未知') {
        lines.push(`🌐 全球排名: ${playerData.globalRankPercent}%`)
      }
      if (playerData.selectedLegend) lines.push(`🦸 当前英雄: ${playerData.selectedLegend}`)
      if (playerData.legendKillsRank) lines.push(`🎯 击杀排名: 全球 ${playerData.legendKillsRank.globalPercent}%`)
      if (playerData.currentState) lines.push(`🎮 当前状态: ${playerData.currentState}`)
      await this.sendToTarget(group.target, lines.join('\n'))
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        this.logger.warn(`player not found during poll: ${groupId}/${player.playerName}`)
        return
      }
      this.logger.error(`poll player failed: ${String((error as Error)?.message || error)}`)
    }
  }

  private formatPlayerRankText(playerData: ApexPlayerStats) {
    const lines = [
      '📊 Apex 段位信息',
      this.timeLine(),
      `👤 玩家: ${playerData.name}`,
      `🕹️ 平台: ${formatPlatform(playerData.platform)}`,
      `🆔 UID: ${playerData.uid || '未知'}`,
      `🏆 段位: ${formatRank(playerData.rankName, playerData.rankDiv)}`,
      `🔢 分数: ${playerData.rankScore}`,
      `🎖️ 等级: ${playerData.level}`,
      `🟢 在线状态: ${playerData.isOnline ? '在线' : '离线'}`,
    ]
    if (playerData.globalRankPercent && playerData.globalRankPercent !== '未知') lines.push(`🌐 全球排名: ${playerData.globalRankPercent}%`)
    if (playerData.selectedLegend) lines.push(`🦸 当前英雄: ${playerData.selectedLegend}`)
    if (playerData.legendKillsRank) lines.push(`🎯 击杀排名: 全球 ${playerData.legendKillsRank.globalPercent}%`)
    if (playerData.currentState) lines.push(`🎮 当前状态: ${playerData.currentState}`)
    return lines.join('\n')
  }

  private formatSeasonInfo(seasonInfo: { seasonNumber: number | null; seasonName: string; startDate: string; endDate: string; timezone: string; updateTimeHint: string; source: string; startIso: string; endIso: string }) {
    const label = seasonInfo.seasonNumber === null
      ? (seasonInfo.seasonName || '未知')
      : seasonInfo.seasonName
        ? `S${seasonInfo.seasonNumber} · ${seasonInfo.seasonName}`
        : `S${seasonInfo.seasonNumber}`

    const startBj = this.toBeijingTime(seasonInfo.startIso)
    const endBj = this.toBeijingTime(seasonInfo.endIso)
    const lines = [
      this.timeLine(),
      '🗓️ Apex 赛季时间信息',
      `📌 当前赛季: ${label}`,
    ]
    if (startBj) lines.push(`🟢 开始时间（北京时间）: ${startBj}`)
    else if (seasonInfo.startDate && seasonInfo.startDate !== '未知') lines.push(`🟢 开始时间: ${seasonInfo.startDate}`)
    if (endBj) lines.push(`🔴 结束时间（北京时间）: ${endBj}`)
    else if (seasonInfo.endDate && seasonInfo.endDate !== '未知') lines.push(`🔴 结束时间: ${seasonInfo.endDate}`)
    const remaining = this.formatRemaining(seasonInfo.endIso)
    if (remaining) lines.push(`⏳ 剩余时间: ${remaining}`)
    const progress = this.formatProgress(seasonInfo.startIso, seasonInfo.endIso)
    if (progress) lines.push(`📈 赛季进度: ${progress}`)
    if (seasonInfo.timezone && seasonInfo.timezone !== '未知') lines.push(`🌐 时区信息: ${seasonInfo.timezone}`)
    if (seasonInfo.updateTimeHint && seasonInfo.updateTimeHint !== '未知') lines.push(`🕐 官网提示更新时间: ${seasonInfo.updateTimeHint}`)
    lines.push(`ℹ️ 数据来源: ${seasonInfo.source}`)
    lines.push('⚠️ 第三方数据仅供参考，请以游戏内实际时间为准。')
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
    if (diff <= 0) return '已结束'
    const day = Math.floor(diff / 86_400_000)
    diff -= day * 86_400_000
    const hour = Math.floor(diff / 3_600_000)
    diff -= hour * 3_600_000
    const minute = Math.floor(diff / 60_000)
    const parts = []
    if (day) parts.push(`${day} 天`)
    if (hour) parts.push(`${hour} 小时`)
    if (minute || !parts.length) parts.push(`${minute} 分钟`)
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
