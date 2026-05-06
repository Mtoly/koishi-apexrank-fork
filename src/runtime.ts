import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bot, Context, Logger, Session } from 'koishi'
import { ApexApiClient, PlayerNotFoundError } from './api'
import { ResolvedConfig } from './config'
import { GroupStore, SettingsStore } from './storage'
import {
  ApexPlayerStats,
  NotificationTarget,
  RuntimeSettings,
  SEASON_KEYWORD_COMMAND_BLOCKLIST,
  StoredGroupRecord,
  StoredPlayerRecord,
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
  private readonly groupStore: GroupStore
  private readonly settingsStore: SettingsStore
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
    this.groupStore = new GroupStore(this.groupsFile, this.logger)
    this.settingsStore = new SettingsStore(this.settingsFile, this.logger)
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

    this.ctx.command('apexrankwatch [input:text]', 'watch player rank in current group')
      .alias('apex\u76d1\u63a7')
      .alias('\u6301\u7eed\u89c6\u5978')
      .action(this.wrap(async (session, input = '') => this.handleWatch(session, input)))

    this.ctx.command('apexranklist', 'show watch list')
      .alias('apex\u5217\u8868')
      .action(this.wrap(async (session) => this.handleList(session)))

    this.ctx.command('apexremark <player> [remark:text]', 'set a remark for a watched player')
      .alias('apex\u5907\u6ce8')
      .action(this.wrap(async (session, player, remark) => this.handleRemark(session, player || '', remark || '')))

    this.ctx.command('apexrankremove [input:text]', 'remove a watch target')
      .alias('apex\u79fb\u9664')
      .alias('\u53d6\u6d88\u6301\u7eed\u89c6\u5978')
      .action(this.wrap(async (session, input = '') => this.handleRemove(session, input)))

    this.ctx.command('apexpredator', 'query predator threshold')
      .alias('apex\u730e\u6740')
      .action(this.wrap(async (session) => this.handlePredator(session)))

    this.ctx.command('apexseason', 'query current season time')
      .alias('apex\u8d5b\u5b63')
      .alias('\u65b0\u8d5b\u5b63')
      .action(this.wrap(async (session) => this.handleSeason(session)))

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
        const seasonInfo = await this.api.fetchCurrentSeasonInfo()
        const suffix = groupId ? '\n\ud83d\udd15 \u5173\u95ed\u8d5b\u5b63\u5173\u952e\u8bcd\u56de\u590d\uff1a/\u8d5b\u5b63\u5173\u95ed' : ''
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

    const lines = [
      this.timeLine(),
      '\ud83d\udcd6 Apex Rank Watch \u5e2e\u52a9',
      '\u3010\u67e5\u8be2\u3011',
      '/apexrank <\u73a9\u5bb6|uid:...> [\u5e73\u53f0]  \u522b\u540d\uff1a/apex\u67e5\u8be2 /\u89c6\u5978',
      '\u793a\u4f8b\uff1a/apexrank moeneri pc',
      '\u3010\u76d1\u63a7\uff08\u7fa4\u804a\uff09\u3011',
      '/apexrankwatch <\u73a9\u5bb6|uid:...> [\u5e73\u53f0]  \u522b\u540d\uff1a/apex\u76d1\u63a7 /\u6301\u7eed\u89c6\u5978',
      '/apexranklist  \u522b\u540d\uff1a/apex\u5217\u8868',
      '/apexrankremove <\u73a9\u5bb6|uid:...> [\u5e73\u53f0]  \u522b\u540d\uff1a/apex\u79fb\u9664 /\u53d6\u6d88\u6301\u7eed\u89c6\u5978',
      '\u3010\u4fe1\u606f\u3011',
      '/apexpredator  \u522b\u540d\uff1a/apex\u730e\u6740',
      '/apexseason  \u522b\u540d\uff1a/apex\u8d5b\u5b63 /\u65b0\u8d5b\u5b63',
      '\u5173\u952e\u8bcd\uff1a\u6d88\u606f\u5305\u542b\u201c\u8d5b\u5b63\u201d\u81ea\u52a8\u56de\u590d\uff08/\u8d5b\u5b63\u5173\u95ed\uff0c/\u8d5b\u5b63\u5f00\u542f\uff09',
      '\u3010\u7ba1\u7406\u3011',
      '/apexblacklist <add|remove|list|clear> <\u73a9\u5bb6ID>  \u522b\u540d\uff1a/apex\u9ed1\u540d\u5355 /\u4e0d\u51c6\u89c6\u5978 /apexban',
      '\u3010\u53c2\u6570\u3011',
      '\u5e73\u53f0\uff1aPC / PS4 / X1 / SWITCH\uff08\u672a\u6307\u5b9a\u65f6\u6309 PC -> PS4 -> X1 -> SWITCH \u81ea\u52a8\u5c1d\u8bd5\uff09',
      'UUID\uff1a\u4f7f\u7528 uid: \u6216 uuid: \u524d\u7f00\uff0c\u4f8b\u5982 /apexrank uid:123456',
      `\u23f1\ufe0f \u76d1\u63a7\u95f4\u9694\uff1a${this.config.checkInterval} \u5206\u949f`,
      `\ud83c\udfaf \u6700\u4f4e\u6709\u6548\u5206\u6570\uff1a${this.config.minValidScore} \u5206`,
      '\u26a0\ufe0f \u5f02\u5e38\u5206\u6570\u5224\u5b9a\uff1a\u4ec5\u5f53\u9ad8\u5206\uff08>1000\uff09\u8dcc\u5230\u63a5\u8fd1 0 \u5206\uff08<10\uff09\u65f6\u624d\u5224\u5b9a\u4e3a\u5f02\u5e38',
      '\ud83d\udee1\ufe0f \u6743\u9650\uff1a\u652f\u6301\u7fa4\u767d\u540d\u5355\u3001\u7528\u6237\u9ed1\u540d\u5355\u3001\u4e3b\u4eba\u8d26\u53f7\u548c\u79c1\u804a\u5f00\u5173',
    ]

    const totalBlacklist = this.configBlacklist.size + this.settings.runtimeBlacklist.length
    if (totalBlacklist) {
      lines.push(`\u26d4 \u9ed1\u540d\u5355\u8bf4\u660e\uff1a\u914d\u7f6e\u9ed1\u540d\u5355 ${this.configBlacklist.size} \u4e2a\uff0c\u52a8\u6001\u9ed1\u540d\u5355 ${this.settings.runtimeBlacklist.length} \u4e2a\u3002`)
    }
    if (this.queryBlocklist.size) {
      lines.push(`\u26d4 \u67e5\u8be2\u5c01\u7981\u73a9\u5bb6\uff1a\u5df2\u914d\u7f6e ${this.queryBlocklist.size} \u4e2a\u3002`)
    }
    return lines.join('\n')
  }

  private async handleRankQuery(session: CommandSession, input: string) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    const { playerName, platform } = this.parsePlayerPlatformInput(input)
    if (!playerName) {
      return [this.timeLine(), '\u26a0\ufe0f \u8bf7\u63d0\u4f9b\u73a9\u5bb6\u540d\u79f0\uff0c\u4f8b\u5982\uff1a/apexrank moeneri'].join('\n')
    }
    if (this.isBlacklisted(playerName) || this.isQueryBlocked(playerName)) {
      return [this.timeLine(), `\u26d4 \u8be5 ID\uff08${playerName}\uff09\u5df2\u88ab\u7ba1\u7406\u5458\u52a0\u5165\u9ed1\u540d\u5355\uff0c\u7981\u6b62\u67e5\u8be2\u3002`].join('\n')
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
      player.platform = usedPlatform
      return this.formatPlayerRankText(player)
    } catch (error) {
      if (error instanceof PlayerNotFoundError) {
        return [this.timeLine(), '\u26a0\ufe0f \u672a\u627e\u5230\u8be5\u73a9\u5bb6\uff0c\u8bf7\u68c0\u67e5\u540d\u79f0\u662f\u5426\u6b63\u786e\uff0c\u6216\u5728\u547d\u4ee4\u672b\u5c3e\u6307\u5b9a\u5e73\u53f0\u3002'].join('\n')
      }
      this.logger.error(`rank query failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('\u67e5\u8be2')
    }
  }

  private async handlePredator(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')
    if (!this.config.apiKey) return this.missingApiKeyText()

    try {
      const predatorInfo = await this.api.fetchPredatorInfo()
      if (!predatorInfo.platforms.length) {
        return [this.timeLine(), '\u26a0\ufe0f \u6682\u672a\u83b7\u53d6\u5230\u730e\u6740\u95e8\u69db\u6570\u636e\u3002'].join('\n')
      }
      const lines = [this.timeLine(), '\ud83c\udff9 Apex \u730e\u6740\u95e8\u69db\u4e0e\u5927\u5e08\u53ca\u4ee5\u4e0a\u4eba\u6570']
      lines.push(`\ud83c\udfae \u6a21\u5f0f: ${predatorInfo.mode === 'RP' ? '\u6392\u4f4d\u79ef\u5206 (RP)' : predatorInfo.mode}`)
      for (const entry of predatorInfo.platforms) {
        lines.push(`\ud83c\udfaf ${formatPlatform(entry.platform)}: \u730e\u6740\u95e8\u69db ${entry.requiredRp ?? '\u672a\u77e5'}\uff0c\u5927\u5e08\u53ca\u4ee5\u4e0a\u4eba\u6570 ${entry.mastersCount ?? '\u672a\u77e5'}`)
      }
      return lines.join('\n')
    } catch (error) {
      this.logger.error(`predator query failed: ${String((error as Error)?.message || error)}`)
      return this.apiRequestFailedText('\u67e5\u8be2')
    }
  }

  private async handleSeason(session: CommandSession) {
    const deny = this.guardAccess(session)
    if (deny) return [this.timeLine(), deny].join('\n')

    try {
      return this.formatSeasonInfo(await this.api.fetchCurrentSeasonInfo())
    } catch (error) {
      this.logger.error(`season query failed: ${String((error as Error)?.message || error)}`)
      return [this.timeLine(), '\u274c \u67e5\u8be2\u5931\u8d25\uff1a\u65e0\u6cd5\u83b7\u53d6\u8d5b\u5b63\u65f6\u95f4\u4fe1\u606f\u3002'].join('\n')
    }
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
      }, target)
      await this.groupStore.save()

      await this.sendToTarget(target, `\u2705 \u6d4b\u8bd5\u6d88\u606f\uff1a\u5df2\u6dfb\u52a0\u5bf9 ${player.name} \u7684\u6392\u540d\u76d1\u63a7\u3002`)
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

    const { playerName, platform } = this.parsePlayerPlatformInput(playerInput)
    if (!playerName) {
      return [this.timeLine(), '\u26a0\ufe0f \u8bf7\u63d0\u4f9b\u8981\u5907\u6ce8\u7684\u73a9\u5bb6\u540d\u79f0\u6216 UID\uff0c\u4f8b\u5982\uff1a/apexremark moeneri \u5927\u4f6c'].join('\n')
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
    if (!playerKey) {
      return [this.timeLine(), `\u26a0\ufe0f \u672c\u7fa4\u6ca1\u6709\u76d1\u63a7 ${playerName}，\u65e0\u6cd5\u8bbe\u7f6e\u5907\u6ce8\u3002`].join('\n')
    }

    const record = group.players[playerKey]
    if (remark) {
      record.remark = remark
      await this.groupStore.save()
      return [this.timeLine(), `\u2705 \u5df2\u5c06 ${record.playerName} \u7684\u5907\u6ce8\u8bbe\u7f6e\u4e3a ${remark}\u3002`].join('\n')
    } else {
      record.remark = undefined
      await this.groupStore.save()
      return [this.timeLine(), `\u2705 \u5df2\u6e05\u9664 ${record.playerName} \u7684\u5907\u6ce8\u3002`].join('\n')
    }
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
      }
      await this.groupStore.save()

      const diff = newScore - oldScore
      const diffText = diff > 0 ? `\u4e0a\u5347 ${diff}` : `\u4e0b\u964d ${Math.abs(diff)}`
      const displayName = player.remark ? `${player.remark} (${playerData.name})` : playerData.name
      const lines = [
        '\ud83d\udcc8 Apex \u6392\u4f4d\u5206\u6570\u53d8\u5316',
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
      '\ud83d\udcca Apex \u6bb5\u4f4d\u4fe1\u606f',
      this.timeLine(),
      `\ud83d\udc64 \u73a9\u5bb6: ${playerData.name}`,
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
