import { Schema } from 'koishi'
import { coerceBool, toInt } from './shared'

export interface Config {
  apiKey?: string
  checkInterval?: number
  dataDir?: string
  maxRetries?: number
  timeout?: number
  minValidScore?: number
  blacklist?: string
  debugLogging?: boolean
  queryBlocklist?: string
  userBlacklist?: string
  ownerQq?: string
  whitelistEnabled?: boolean
  whitelistGroups?: string
  allowPrivate?: boolean
  api_key?: string
  check_interval?: number
  max_retries?: number
  timeout_ms?: number
  min_valid_score?: number
  debug_logging?: boolean
  query_blocklist?: string
  user_blacklist?: string
  owner_qq?: string
  whitelist_enabled?: boolean
  whitelist_groups?: string
  allow_private?: boolean
  data_dir?: string
}

export interface ResolvedConfig {
  apiKey: string
  checkInterval: number
  dataDir: string
  maxRetries: number
  timeoutMs: number
  minValidScore: number
  blacklist: string
  debugLogging: boolean
  queryBlocklist: string
  userBlacklist: string
  ownerQq: string
  whitelistEnabled: boolean
  whitelistGroups: string
  allowPrivate: boolean
}

export const ConfigSchema: Schema<Config> = Schema.object({
  apiKey: Schema.string().default('').description('Apex API Key。留空时插件仍可加载，但玩家查询、监控和猎杀线功能不可用。'),
  debugLogging: Schema.boolean().default(false).description('输出调试日志，并自动对 API Key 做脱敏。'),
  checkInterval: Schema.number().min(1).default(2).description('轮询监控间隔，单位为分钟。'),
  timeout: Schema.number().min(1000).default(10000).description('HTTP 请求超时时间，单位为毫秒。'),
  maxRetries: Schema.number().min(0).default(3).description('请求失败后的最大重试次数。'),
  minValidScore: Schema.number().min(0).default(1).description('最低有效分数，低于该值的数据将视为异常。'),
  blacklist: Schema.string().default('').description('全局黑名单，禁止查询和监控，多个 ID 用中英文逗号分隔。'),
  queryBlocklist: Schema.string().default('').description('仅禁止查询和监控的玩家 ID 列表，多个 ID 用中英文逗号分隔。'),
  userBlacklist: Schema.string().default('').description('禁止使用插件的用户 ID 或 QQ 号列表，多个值用中英文逗号分隔。'),
  ownerQq: Schema.string().default('').description('主人账号列表，拥有最高权限，多个值用中英文逗号分隔。'),
  whitelistEnabled: Schema.boolean().default(false).description('是否开启群白名单模式。'),
  whitelistGroups: Schema.string().default('').description('允许使用插件的群 ID 列表，多个值用中英文逗号分隔。'),
  allowPrivate: Schema.boolean().default(true).description('是否允许在私聊中使用查询、帮助和赛季命令。'),
  dataDir: Schema.string().default('./data/apexrankwatch').description('数据目录。旧版 groups.json 与 AstrBot 数据会在此目录下自动兼容。'),
})

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function pickNumber(fallback: number, ...values: unknown[]) {
  for (const value of values) {
    const numeric = toInt(value)
    if (numeric !== null) return numeric
  }
  return fallback
}

function pickBoolean(fallback: boolean, ...values: unknown[]) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    return coerceBool(value, fallback)
  }
  return fallback
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    apiKey: pickString(config.apiKey, config.api_key),
    debugLogging: pickBoolean(false, config.debugLogging, config.debug_logging),
    checkInterval: Math.max(1, pickNumber(2, config.checkInterval, config.check_interval)),
    timeoutMs: Math.max(1000, pickNumber(10000, config.timeout, config.timeout_ms)),
    maxRetries: Math.max(0, pickNumber(3, config.maxRetries, config.max_retries)),
    minValidScore: Math.max(0, pickNumber(1, config.minValidScore, config.min_valid_score)),
    blacklist: pickString(config.blacklist),
    queryBlocklist: pickString(config.queryBlocklist, config.query_blocklist),
    userBlacklist: pickString(config.userBlacklist, config.user_blacklist),
    ownerQq: pickString(config.ownerQq, config.owner_qq),
    whitelistEnabled: pickBoolean(false, config.whitelistEnabled, config.whitelist_enabled),
    whitelistGroups: pickString(config.whitelistGroups, config.whitelist_groups),
    allowPrivate: pickBoolean(true, config.allowPrivate, config.allow_private),
    dataDir: pickString(config.dataDir, config.data_dir) || './data/apexrankwatch',
  }
}
