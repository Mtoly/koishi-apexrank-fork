import { Schema } from 'koishi'
import { coerceBool, toInt } from './shared'

type StringList = string | string[]

export interface Config {
  apiKey?: string
  checkInterval?: number
  dataDir?: string
  maxRetries?: number
  timeout?: number
  minValidScore?: number
  blacklist?: StringList
  debugLogging?: boolean
  queryBlocklist?: StringList
  userBlacklist?: StringList
  ownerQq?: StringList
  whitelistEnabled?: boolean
  whitelistGroups?: StringList
  allowPrivate?: boolean
  api_key?: string
  check_interval?: number
  max_retries?: number
  timeout_ms?: number
  min_valid_score?: number
  debug_logging?: boolean
  query_blocklist?: StringList
  user_blacklist?: StringList
  owner_qq?: StringList
  whitelist_enabled?: boolean
  whitelist_groups?: StringList
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

const listSchema = (description: string) => Schema.array(Schema.string()).role('table').default([]).description(
  `${description}。Koishi 控制台建议逐项填写；直接加载旧版逗号分隔字符串仍在运行时兼容。`,
)

export const ConfigSchema = Schema.intersect([
  Schema.object({
    apiKey: Schema.string().role('secret').default('').description('Apex Legends API Key。留空时插件仍可加载，但玩家查询、监控和猎杀线功能不可用。'),
    debugLogging: Schema.boolean().default(false).description('输出脱敏调试日志，用于排查 API 返回结构和错误原因。'),
  }).description('API 设置'),

  Schema.object({
    checkInterval: Schema.number().min(1).step(1).default(2).description('排位分监控轮询间隔，单位为分钟。'),
    timeout: Schema.number().min(1000).step(500).default(10000).description('HTTP 请求超时时间，单位为毫秒。'),
    maxRetries: Schema.number().min(0).step(1).default(3).description('API 请求失败后的最大重试次数。'),
    minValidScore: Schema.number().min(0).step(1).default(1).description('最低有效排位分，低于该值的数据会视为异常并跳过通知。'),
  }).description('监控与请求'),

  Schema.object({
    allowPrivate: Schema.boolean().default(true).description('是否允许私聊使用查询、帮助、地图、赛季和猎杀线命令。'),
    ownerQq: listSchema('主人账号 ID / QQ 号列表，拥有最高权限'),
    userBlacklist: listSchema('禁止使用插件的用户 ID / QQ 号列表'),
    whitelistEnabled: Schema.boolean().default(false).description('是否开启群白名单模式。开启后只有白名单群可以使用插件。'),
    whitelistGroups: listSchema('允许使用插件的群 ID 列表'),
  }).description('权限控制'),

  Schema.object({
    blacklist: listSchema('全局玩家黑名单，禁止查询和监控这些玩家 ID / UID'),
    queryBlocklist: listSchema('查询黑名单，禁止查询和监控这些玩家 ID / UID'),
  }).description('玩家名单'),

  Schema.object({
    dataDir: Schema.string().default('./data/apexrankwatch').description('数据与图片缓存目录。旧版 groups.json 与 AstrBot 风格数据会在此目录下自动兼容。'),
  }).description('数据存储'),
]) as Schema<Config>

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function pickStringList(...values: unknown[]) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const text = value.map((item) => String(item).trim()).filter(Boolean).join(',')
      if (text) return text
    }
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
    blacklist: pickStringList(config.blacklist),
    queryBlocklist: pickStringList(config.queryBlocklist, config.query_blocklist),
    userBlacklist: pickStringList(config.userBlacklist, config.user_blacklist),
    ownerQq: pickStringList(config.ownerQq, config.owner_qq),
    whitelistEnabled: pickBoolean(false, config.whitelistEnabled, config.whitelist_enabled),
    whitelistGroups: pickStringList(config.whitelistGroups, config.whitelist_groups),
    allowPrivate: pickBoolean(true, config.allowPrivate, config.allow_private),
    dataDir: pickString(config.dataDir, config.data_dir) || './data/apexrankwatch',
  }
}
