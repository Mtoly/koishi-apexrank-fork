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
  leaderboardRenderMode?: 'html' | 'legacy' | 'text'
  leaderboardEnableLegacyImageFallback?: boolean
  leaderboardEnableTextFallback?: boolean
  leaderboardResourceDir?: string
  leaderboardAvatarCacheTTL?: number
  leaderboardAvatarFailureCacheTTL?: number
  leaderboardAvatarFetchTimeout?: number
  leaderboardViewportWidth?: number
  leaderboardDeviceScaleFactor?: number
  leaderboardWaitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
  leaderboardMaxRowsPerImage?: number
  leaderboardTitleFont?: string
  leaderboardBodyFont?: string
  leaderboardNumberFont?: string
  leaderboardFontFallbackEnabled?: boolean
  leaderboardThemePreset?: string
  leaderboardBackgroundType?: 'preset' | 'css' | 'file' | 'url' | 'api'
  leaderboardBackgroundValue?: string
  leaderboardBackgroundApiKey?: string
  leaderboardCustomCss?: string
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
  leaderboardRenderMode: 'html' | 'legacy' | 'text'
  leaderboardEnableLegacyImageFallback: boolean
  leaderboardEnableTextFallback: boolean
  leaderboardResourceDir: string
  leaderboardAvatarCacheTTL: number
  leaderboardAvatarFailureCacheTTL: number
  leaderboardAvatarFetchTimeout: number
  leaderboardViewportWidth: number
  leaderboardDeviceScaleFactor: number
  leaderboardWaitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
  leaderboardMaxRowsPerImage: number
  leaderboardTitleFont: string
  leaderboardBodyFont: string
  leaderboardNumberFont: string
  leaderboardFontFallbackEnabled: boolean
  leaderboardThemePreset: string
  leaderboardBackgroundType: 'preset' | 'css' | 'file' | 'url' | 'api'
  leaderboardBackgroundValue: string
  leaderboardBackgroundApiKey: string
  leaderboardCustomCss: string
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

  Schema.object({
    leaderboardRenderMode: Schema.union([
      Schema.const('html').description('优先使用 HTML/CSS + Puppeteer 榜单图片'),
      Schema.const('legacy').description('优先使用现有榜单图片实现'),
      Schema.const('text').description('仅输出文本榜单'),
    ]).default('html').description('榜单输出模式。'),
    leaderboardEnableLegacyImageFallback: Schema.boolean().default(true).description('HTML 榜单渲染失败后，是否回退到现有 image.ts 榜单图片。'),
    leaderboardEnableTextFallback: Schema.boolean().default(true).description('图像渲染失败后，是否最终回退为文本榜单。'),
  }).description('榜单输出策略'),

  Schema.object({
    leaderboardResourceDir: Schema.string().default('./data/apexrankwatch/leaderboard').description('榜单专用资源目录，包含字体、头像缓存、背景等资源。'),
    leaderboardAvatarCacheTTL: Schema.number().min(0).step(60).default(86400).description('头像成功缓存有效期，单位为秒。'),
    leaderboardAvatarFailureCacheTTL: Schema.number().min(0).step(10).default(300).description('头像失败缓存有效期，单位为秒。'),
    leaderboardAvatarFetchTimeout: Schema.number().min(1000).step(500).default(5000).description('头像抓取超时时间，单位为毫秒。'),
  }).description('榜单资源与缓存'),

  Schema.object({
    leaderboardViewportWidth: Schema.number().min(640).step(10).default(1180).description('HTML 榜单渲染的基础视口宽度。'),
    leaderboardDeviceScaleFactor: Schema.number().min(1).max(3).step(0.1).default(1).description('HTML 榜单渲染的设备像素比。'),
    leaderboardWaitUntil: Schema.union([
      Schema.const('load'),
      Schema.const('domcontentloaded'),
      Schema.const('networkidle0'),
      Schema.const('networkidle2'),
    ]).default('networkidle0').description('Puppeteer 页面等待策略。'),
    leaderboardMaxRowsPerImage: Schema.number().min(1).step(1).default(10).description('单张榜单图片最多展示的榜单行数。'),
  }).description('榜单 HTML 渲染'),

  Schema.object({
    leaderboardTitleFont: Schema.string().default('Noto Sans CJK SC').description('榜单标题字体。'),
    leaderboardBodyFont: Schema.string().default('Noto Sans CJK SC').description('榜单正文与昵称字体。'),
    leaderboardNumberFont: Schema.string().default('Noto Sans CJK SC').description('榜单数字与排名字体。'),
    leaderboardFontFallbackEnabled: Schema.boolean().default(true).description('是否启用内置字体回退策略。'),
  }).description('榜单字体设置'),

  Schema.object({
    leaderboardThemePreset: Schema.string().default('apex-red').description('榜单主题预设。可选值由内置主题决定，例如 default / dark / apex-red / minimal。'),
    leaderboardBackgroundType: Schema.union([
      Schema.const('preset'),
      Schema.const('css'),
      Schema.const('file'),
      Schema.const('url'),
      Schema.const('api'),
    ]).default('preset').description('榜单背景类型。'),
    leaderboardBackgroundValue: Schema.string().default('').description('背景配置值，可为 CSS 内容、本地文件名、URL 或 API 地址。'),
    leaderboardBackgroundApiKey: Schema.string().role('secret').default('').description('当背景类型为 API 时使用的访问凭证。'),
    leaderboardCustomCss: Schema.string().role('textarea', { rows: [4, 8] }).default('').description('附加到榜单 HTML 模板中的自定义 CSS。'),
  }).description('榜单主题与背景'),
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
    leaderboardRenderMode: (pickString(config.leaderboardRenderMode) as 'html' | 'legacy' | 'text') || 'html',
    leaderboardEnableLegacyImageFallback: pickBoolean(true, config.leaderboardEnableLegacyImageFallback),
    leaderboardEnableTextFallback: pickBoolean(true, config.leaderboardEnableTextFallback),
    leaderboardResourceDir: pickString(config.leaderboardResourceDir) || './data/apexrankwatch/leaderboard',
    leaderboardAvatarCacheTTL: Math.max(0, pickNumber(86400, config.leaderboardAvatarCacheTTL)),
    leaderboardAvatarFailureCacheTTL: Math.max(0, pickNumber(300, config.leaderboardAvatarFailureCacheTTL)),
    leaderboardAvatarFetchTimeout: Math.max(1000, pickNumber(5000, config.leaderboardAvatarFetchTimeout)),
    leaderboardViewportWidth: Math.max(640, pickNumber(1180, config.leaderboardViewportWidth)),
    leaderboardDeviceScaleFactor: Math.max(1, Math.min(3, Number(config.leaderboardDeviceScaleFactor ?? 1) || 1)),
    leaderboardWaitUntil: (pickString(config.leaderboardWaitUntil) as 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2') || 'networkidle0',
    leaderboardMaxRowsPerImage: Math.max(1, pickNumber(10, config.leaderboardMaxRowsPerImage)),
    leaderboardTitleFont: pickString(config.leaderboardTitleFont) || 'Noto Sans CJK SC',
    leaderboardBodyFont: pickString(config.leaderboardBodyFont) || 'Noto Sans CJK SC',
    leaderboardNumberFont: pickString(config.leaderboardNumberFont) || 'Noto Sans CJK SC',
    leaderboardFontFallbackEnabled: pickBoolean(true, config.leaderboardFontFallbackEnabled),
    leaderboardThemePreset: pickString(config.leaderboardThemePreset) || 'apex-red',
    leaderboardBackgroundType: (pickString(config.leaderboardBackgroundType) as 'preset' | 'css' | 'file' | 'url' | 'api') || 'preset',
    leaderboardBackgroundValue: pickString(config.leaderboardBackgroundValue),
    leaderboardBackgroundApiKey: pickString(config.leaderboardBackgroundApiKey),
    leaderboardCustomCss: String(config.leaderboardCustomCss || '').trim(),
  }
}
