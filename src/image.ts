import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  ApexPlayerStats,
  LeaderboardEntry,
  MapRotationEntry,
  MapRotationInfo,
  PredatorInfo,
  PredatorPlatformInfo,
  SeasonInfo,
  StoredPlayerRecord,
  formatPlatform,
  formatPlayerDisplayName,
  formatRank,
  translate,
} from './shared'

const CARD_WIDTH = 1122
const CARD_HEIGHT = 1402
const HELP_CARD_HEIGHT = 2380
const MONITOR_ADDED_HEIGHT = 1040
const MONITOR_LIST_ROW_LIMIT = 8
const MAP_WIDTH = 900
const MAP_HEIGHT = 320
const MAP_CURRENT_HEIGHT = 212
const CACHE_TTL_MS = 60_000

type Box = [number, number, number, number]
type Color = [number, number, number, number?]
type CacheEntry = { path: string; savedAt: number }
type ImageRenderOptions = {
  checkInterval?: number
  minValidScore?: number
  configBlacklistCount?: number
  runtimeBlacklistCount?: number
  queryBlocklistCount?: number
}

type RankRenderPlayer = ApexPlayerStats & {
  displayName?: string
}

type LeaderboardRenderOptions = {
  periodLabel: string
  directionLabel: string
  periodRangeText: string
}

function packageRoot() {
  return resolve(__dirname, '..')
}

function assetPath(...parts: string[]) {
  return resolve(packageRoot(), 'assets', ...parts)
}

function rgba([red, green, blue, alpha = 255]: Color) {
  return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`
}

function safeName(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'card'
}

function font(size: number, bold = false) {
  return `${bold ? 700 : 400} ${size}px "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "WenQuanYi Zen Hei", "SimHei", "Arial Unicode MS", "Segoe UI", sans-serif`
}

function setFont(ctx: any, size: number, bold = false) {
  ctx.font = font(size, bold)
}

function textMetrics(ctx: any, value: string) {
  const metrics = ctx.measureText(value)
  const ascent = metrics.actualBoundingBoxAscent || 0
  const descent = metrics.actualBoundingBoxDescent || 0
  return {
    width: metrics.width,
    height: ascent + descent || Number.parseInt(String(ctx.font).match(/\d+/)?.[0] || '20', 10),
    ascent,
    descent,
  }
}

function centeredTextX(ctx: any, value: string, left: number, right: number) {
  return left + ((right - left) - textMetrics(ctx, value).width) / 2
}

function centeredTextY(ctx: any, value: string, top: number, bottom: number) {
  const metrics = textMetrics(ctx, value)
  return top + ((bottom - top) - metrics.height) / 2 + metrics.ascent
}

function fitFont(ctx: any, value: string, size: number, minSize: number, maxWidth: number, bold = false) {
  for (let current = size; current >= minSize; current -= 2) {
    setFont(ctx, current, bold)
    if (textMetrics(ctx, String(value || '')).width <= maxWidth) return current
  }
  setFont(ctx, minSize, bold)
  return minSize
}

function drawTextStroked(ctx: any, x: number, y: number, value: string, color: Color, strokeWidth = 1) {
  const text = String(value || '')
  ctx.lineJoin = 'round'
  ctx.strokeStyle = rgba([0, 0, 0, 205])
  ctx.lineWidth = strokeWidth * 2
  ctx.strokeText(text, x, y)
  ctx.fillStyle = rgba(color)
  ctx.fillText(text, x, y)
}

function drawCenteredStrokedText(
  ctx: any,
  value: string,
  size: number,
  bold: boolean,
  left: number,
  right: number,
  top: number,
  bottom: number,
  color: Color,
  strokeWidth = 1,
) {
  setFont(ctx, size, bold)
  drawTextStroked(ctx, centeredTextX(ctx, value, left, right), centeredTextY(ctx, value, top, bottom), value, color, strokeWidth)
}

function drawTextWithShadow(ctx: any, x: number, y: number, value: string, size: number, bold: boolean, color: Color) {
  setFont(ctx, size, bold)
  ctx.fillStyle = rgba([0, 0, 0, 180])
  ctx.fillText(value, x + 2, y + 2)
  ctx.fillStyle = rgba(color)
  ctx.fillText(value, x, y)
}

function roundedRect(ctx: any, box: Box, radius: number) {
  ctx.beginPath()
  ctx.roundRect(box[0], box[1], box[2] - box[0], box[3] - box[1], radius)
}

function fillRoundedRect(ctx: any, box: Box, radius: number, fill: Color, stroke?: Color, lineWidth = 1) {
  roundedRect(ctx, box, radius)
  ctx.fillStyle = rgba(fill)
  ctx.fill()
  if (stroke) {
    ctx.strokeStyle = rgba(stroke)
    ctx.lineWidth = lineWidth
    ctx.stroke()
  }
}

function drawPanelBase(ctx: any, box: Box, fill: Color, outlineAlpha: number) {
  fillRoundedRect(ctx, box, 8, fill, [92, 98, 108, 150], 2)
  fillRoundedRect(ctx, [box[0] + 8, box[1] + 8, box[2] - 8, box[3] - 8], 7, [0, 0, 0, 0], [224, 48, 52, outlineAlpha], 2)
  ctx.strokeStyle = rgba([220, 48, 52, 120])
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(box[0] + 24, box[1] + 28)
  ctx.lineTo(box[0] + 118, box[1] + 28)
  ctx.moveTo(box[2] - 118, box[3] - 28)
  ctx.lineTo(box[2] - 24, box[3] - 28)
  ctx.stroke()
}

function drawOctagonPath(ctx: any, box: Box, cut = 24) {
  const [left, top, right, bottom] = box
  ctx.beginPath()
  ctx.moveTo(left + cut, top)
  ctx.lineTo(right - cut, top)
  ctx.lineTo(right, top + cut)
  ctx.lineTo(right, bottom - cut)
  ctx.lineTo(right - cut, bottom)
  ctx.lineTo(left + cut, bottom)
  ctx.lineTo(left, bottom - cut)
  ctx.lineTo(left, top + cut)
  ctx.closePath()
}

function drawIconOctagon(ctx: any, box: Box) {
  drawOctagonPath(ctx, box)
  ctx.fillStyle = rgba([23, 24, 29, 230])
  ctx.fill()
  ctx.strokeStyle = rgba([218, 49, 52, 190])
  ctx.lineWidth = 2
  ctx.stroke()
}

function transparentContentBounds(image: any): Box | null {
  const width = image.width
  const height = image.height
  if (!width || !height) return null
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, width, height).data
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3]
      if (alpha <= 8) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < left || bottom < top) return null
  return [left, top, right + 1, bottom + 1]
}

async function drawImageContain(ctx: any, filePath: string, box: Box, clipOctagon = false, cropTransparentPadding = true) {
  if (!existsSync(filePath)) return false
  const image = await loadImage(filePath)
  const width = box[2] - box[0]
  const height = box[3] - box[1]
  const source = cropTransparentPadding ? transparentContentBounds(image) : null
  const sx = source?.[0] ?? 0
  const sy = source?.[1] ?? 0
  const sw = (source?.[2] ?? image.width) - sx
  const sh = (source?.[3] ?? image.height) - sy
  const scale = Math.min(width / sw, height / sh)
  const drawWidth = sw * scale
  const drawHeight = sh * scale
  const x = box[0] + (width - drawWidth) / 2
  const y = box[1] + (height - drawHeight) / 2
  ctx.save()
  if (clipOctagon) {
    drawOctagonPath(ctx, box, Math.max(12, Math.min(width, height) / 5))
    ctx.clip()
  }
  ctx.drawImage(image, sx, sy, sw, sh, x, y, drawWidth, drawHeight)
  ctx.restore()
  return true
}

async function drawImageCover(ctx: any, filePath: string, box: Box, focusY = 0.5) {
  if (!existsSync(filePath)) return false
  const image = await loadImage(filePath)
  const width = box[2] - box[0]
  const height = box[3] - box[1]
  const scale = Math.max(width / image.width, height / image.height)
  const sourceWidth = width / scale
  const sourceHeight = height / scale
  const sourceX = (image.width - sourceWidth) / 2
  const sourceY = Math.max(0, Math.min(image.height - sourceHeight, (image.height - sourceHeight) * focusY))
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, box[0], box[1], width, height)
  return true
}

function normalizeAssetToken(value: string) {
  return String(value || '').trim().replace(/[·'’\-_ ]+/g, '').toLowerCase()
}

const DIVISION_RANKS = new Set(['rookie', 'bronze', 'silver', 'gold', 'platinum', 'diamond'])

function rankIconName(rankName: string, rankDiv = 0) {
  const aliases: Record<string, string> = {
    rookie: 'rookie',
    unranked: 'rookie',
    novice: 'rookie',
    菜鸟: 'rookie',
    青铜: 'bronze',
    bronze: 'bronze',
    白银: 'silver',
    silver: 'silver',
    黄金: 'gold',
    gold: 'gold',
    白金: 'platinum',
    铂金: 'platinum',
    platinum: 'platinum',
    钻石: 'diamond',
    diamond: 'diamond',
    大师: 'master',
    master: 'master',
    猎杀: 'predator',
    apex猎杀者: 'predator',
    apexpredator: 'predator',
    predator: 'predator',
  }
  const normalized = normalizeAssetToken(rankName)
  const key = aliases[normalized] || (normalized.includes('猎杀') ? 'predator' : normalized) || 'rookie'
  const division = Number(rankDiv)
  if (DIVISION_RANKS.has(key) && Number.isInteger(division) && division >= 1 && division <= 4) {
    const divisionName = `${key}_${division}.png`
    if (existsSync(assetPath('ranks', divisionName))) return divisionName
  }
  return `${key}.png`
}

function legendIconName(legendName: string) {
  const aliases: Record<string, string> = {
    艾许: 'ash',
    ash: 'ash',
    班加罗尔: 'bangalore',
    bangalore: 'bangalore',
    寻血猎犬: 'bloodhound',
    bloodhound: 'bloodhound',
    卡特莉丝: 'catalyst',
    催化姬: 'catalyst',
    catalyst: 'catalyst',
    侵蚀: 'caustic',
    caustic: 'caustic',
    密客: 'crypto',
    crypto: 'crypto',
    暴雷: 'fuse',
    fuse: 'fuse',
    直布罗陀: 'gibraltar',
    gibraltar: 'gibraltar',
    地平线: 'horizon',
    horizon: 'horizon',
    命脉: 'lifeline',
    lifeline: 'lifeline',
    罗芭: 'loba',
    loba: 'loba',
    疯玛吉: 'mad_maggie',
    madmaggie: 'mad_maggie',
    幻象: 'mirage',
    mirage: 'mirage',
    纽卡斯尔: 'newcastle',
    newcastle: 'newcastle',
    动力小子: 'octane',
    octane: 'octane',
    探路者: 'pathfinder',
    pathfinder: 'pathfinder',
    兰伯特: 'rampart',
    rampart: 'rampart',
    亡灵: 'revenant',
    revenant: 'revenant',
    希尔: 'seer',
    seer: 'seer',
    琉雀: 'sparrow',
    麻雀: 'sparrow',
    sparrow: 'sparrow',
    瓦尔基里: 'valkyrie',
    valkyrie: 'valkyrie',
    万蒂奇: 'vantage',
    vantage: 'vantage',
    沃特森: 'wattson',
    wattson: 'wattson',
    恶灵: 'wraith',
    wraith: 'wraith',
    导管: 'conduit',
    导线管: 'conduit',
    conduit: 'conduit',
    弹道: 'ballistic',
    ballistic: 'ballistic',
    变幻: 'alter',
    alter: 'alter',
    艾克赛尔: 'axle',
    axle: 'axle',
  }
  const normalized = normalizeAssetToken(legendName)
  return `${aliases[normalized] || normalized || 'octane'}.png`
}

function statusAssetName(status: string) {
  const normalized = normalizeAssetToken(status)
  const aliases: Record<string, string> = {
    比赛中: 'in_match',
    正在比赛: 'in_match',
    游戏中: 'in_match',
    inmatch: 'in_match',
    match: 'in_match',
    在大厅: 'in_lobby',
    大厅中: 'in_lobby',
    等待中: 'in_lobby',
    inlobby: 'in_lobby',
    lobby: 'in_lobby',
    离线: 'offline',
    offline: 'offline',
  }
  let key = aliases[normalized]
  if (!key && (normalized.includes('比赛') || normalized.includes('match'))) key = 'in_match'
  if (!key && (normalized.includes('大厅') || normalized.includes('lobby'))) key = 'in_lobby'
  if (!key && (normalized.includes('离线') || normalized.includes('offline'))) key = 'offline'
  return `${key || normalized || 'offline'}.png`
}

function mapAssetName(mapName: string) {
  const aliases: Record<string, string> = {
    'Broken Moon': 'Broken_Moon.png',
    'E-District': 'E-District.png',
    'Kings Canyon': 'Kings_Canyon.png',
    Olympus: 'Olympus.png',
    'Storm Point': 'Storm_Point.png',
    "World's Edge": 'Worlds_Edge.png',
    'Worlds Edge': 'Worlds_Edge.png',
  }
  const normalized = String(mapName || '').trim()
  if (aliases[normalized]) return aliases[normalized]
  const slug = normalized.replace(/['’]/g, '').replace(/\s+/g, '_').replace(/[^a-z0-9_-]/gi, '')
  return `${slug || 'unknown'}.png`
}

function formatScore(value: number) {
  try {
    return String(Math.trunc(value))
  } catch {
    return String(value)
  }
}

function rankDisplay(player: ApexPlayerStats) {
  return formatRank(player.rankName, player.rankDiv) || '未知'
}

function playerDisplayName(player: RankRenderPlayer) {
  return formatPlayerDisplayName(player.displayName || player.name, undefined, false) || '未知玩家'
}

function displayMapName(entry: MapRotationEntry) {
  const translatedZh = translate(entry.mapNameZh)
  if (translatedZh && translatedZh !== entry.mapNameZh) return translatedZh
  const translatedName = translate(entry.mapName)
  if (translatedName && translatedName !== entry.mapName) return translatedName
  return entry.mapNameZh || entry.mapName || '未知地图'
}

function rankPercent(value: string) {
  const text = String(value || '').trim()
  if (!text || text === '未知') return '未知'
  return text.endsWith('%') ? text : `${text}%`
}

function dateTimeInShanghai(timestamp: number | null) {
  if (!timestamp) return null
  const date = new Date(timestamp * 1000)
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return { month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

function rotationRange(entry: MapRotationEntry) {
  const start = dateTimeInShanghai(entry.start)
  const end = dateTimeInShanghai(entry.end)
  if (start && end) {
    if (start.month === end.month && start.day === end.day) return `${start.hour}:${start.minute} - ${end.hour}:${end.minute}`
    return `${start.month}-${start.day} ${start.hour}:${start.minute} - ${end.month}-${end.day} ${end.hour}:${end.minute}`
  }
  return '未知 - 未知'
}

function remainingSecondsFromTimer(timer: string) {
  const parts = String(timer || '').trim().split(':')
  if (![2, 3].includes(parts.length) || parts.some((part) => !/^\d+$/.test(part))) return null
  const numbers = parts.map(Number)
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1]
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
}

function remainingForCard(entry: MapRotationEntry) {
  let seconds = remainingSecondsFromTimer(entry.remainingTimer)
  if (seconds === null && entry.end) seconds = Math.max(0, Math.trunc(entry.end - Date.now() / 1000))
  if (seconds === null) return entry.remainingTimer || '未知'
  const minutes = Math.max(0, Math.trunc(seconds / 60))
  const days = Math.trunc(minutes / 1440)
  const hours = Math.trunc((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days) return `${days}天${hours}时`
  if (hours) return `${hours}时${mins}分`
  return `${mins}分`
}

function remainingFraction(entry: MapRotationEntry) {
  const seconds = remainingSecondsFromTimer(entry.remainingTimer)
  if (seconds !== null && entry.start && entry.end && entry.end > entry.start) {
    return Math.min(1, Math.max(0, seconds / (entry.end - entry.start)))
  }
  if (entry.start && entry.end && entry.end > entry.start) {
    return Math.min(1, Math.max(0, (entry.end - Date.now() / 1000) / (entry.end - entry.start)))
  }
  return 0.72
}

function toShanghaiText(iso: string) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

function nowText() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date())
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '暂无'
  return Math.trunc(value).toLocaleString('en-US')
}

export class ApexImageRenderer {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly dataDir: string) {}

  async renderHelp(options: ImageRenderOptions = {}) {
    const key = `help:${JSON.stringify(options)}`
    return this.cached(key, 'help_cards', 'apex_help.png', async (filePath) => {
      const canvas = createCanvas(CARD_WIDTH, HELP_CARD_HEIGHT)
      const ctx = canvas.getContext('2d')
      this.drawRankBackground(ctx, CARD_WIDTH, HELP_CARD_HEIGHT)
      this.drawOuterFrame(ctx, CARD_WIDTH, HELP_CARD_HEIGHT)
      await this.drawHelpCardHeader(ctx)
      for (const [box, title, rows] of this.helpCardSections(options)) {
        this.drawHelpSection(ctx, box, title, rows)
      }
      await this.writePng(canvas, filePath)
    })
  }

  async renderMonitorAdded(player: RankRenderPlayer, platform: string, options: ImageRenderOptions = {}) {
    const key = `monitor-added:${JSON.stringify({ player, platform, options })}`
    return this.cached(key, 'monitor_added_cards', `monitor_added_${safeName(playerDisplayName(player))}.png`, async (filePath) => {
      const canvas = createCanvas(CARD_WIDTH, MONITOR_ADDED_HEIGHT)
      const ctx = canvas.getContext('2d')
      this.drawRankBackground(ctx, CARD_WIDTH, MONITOR_ADDED_HEIGHT)
      this.drawOuterFrame(ctx, CARD_WIDTH, MONITOR_ADDED_HEIGHT)
      await this.drawMonitorAddedHeader(ctx)
      this.drawMonitorAddedStatus(ctx)
      await this.drawPlayerProfilePanel(ctx, [54, 482, 518, 792], player)
      await this.drawRankBadgePanel(
        ctx,
        [536, 482, 1070, 792],
        '当前段位',
        rankDisplay(player),
        player.rankName,
        player.rankDiv,
        `${formatScore(player.rankScore)} 分`,
      )
      this.drawMiniInfoPill(ctx, [54, 820, 370, 920], '平台', formatPlatform(platform || player.platform))
      await this.drawMonitorAddedLegendPill(ctx, [388, 820, 734, 920], player.selectedLegend || '未知')
      this.drawMiniInfoPill(ctx, [752, 820, 1068, 920], '检测间隔', `${options.checkInterval ?? 2} 分钟`)
      await this.writePng(canvas, filePath)
    })
  }

  async renderWatchList(players: StoredPlayerRecord[], options: ImageRenderOptions = {}) {
    const key = `watch-list:${JSON.stringify({ players, options })}`
    return this.cached(key, 'rank_watch_list_cards', 'rank_watch_list.png', async (filePath) => {
      const shownPlayers = players.slice(0, MONITOR_LIST_ROW_LIMIT)
      const rowHeight = 118
      const rowGap = 14
      const footerHeight = 92
      const listTop = 366
      const height = Math.max(760, listTop + shownPlayers.length * (rowHeight + rowGap) + footerHeight)
      const canvas = createCanvas(CARD_WIDTH, height)
      const ctx = canvas.getContext('2d')
      this.drawRankBackground(ctx, CARD_WIDTH, height)
      this.drawOuterFrame(ctx, CARD_WIDTH, height)
      await this.drawMonitorListHeader(ctx, players.length, options)
      this.drawMonitorListSummary(ctx, players.length, options)

      let y = listTop
      for (let index = 0; index < shownPlayers.length; index += 1) {
        await this.drawMonitorListRow(ctx, [54, y, CARD_WIDTH - 54, y + rowHeight], index + 1, shownPlayers[index])
        y += rowHeight + rowGap
      }

      const footerText = players.length > shownPlayers.length
        ? `已展示前 ${shownPlayers.length} 位，还有 ${players.length - shownPlayers.length} 位玩家未展示`
        : '时间均为北京时间'
      drawCenteredStrokedText(ctx, footerText, fitFont(ctx, footerText, 28, 20, CARD_WIDTH - 150, true), true, 54, CARD_WIDTH - 54, height - 84, height - 40, [202, 210, 220, 255])
      await this.writePng(canvas, filePath)
    })
  }

  async renderPlayerRank(player: RankRenderPlayer) {
    const key = `player:${JSON.stringify(player)}`
    return this.cached(key, 'player_rank_cards', `player_rank_${safeName(playerDisplayName(player))}.png`, async (filePath) => {
      const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT)
      const ctx = canvas.getContext('2d')
      this.drawRankBackground(ctx, CARD_WIDTH, CARD_HEIGHT)
      this.drawOuterFrame(ctx, CARD_WIDTH, CARD_HEIGHT)
      this.drawPlayerRankHeader(ctx)
      this.drawTimeBar(ctx)
      await this.drawPlayerProfilePanel(ctx, [54, 360, 518, 670], player)
      await this.drawRankBadgePanel(ctx, [536, 360, 1070, 670], '当前段位', rankDisplay(player), player.rankName, player.rankDiv)
      this.drawPlayerScorePanel(ctx, [54, 690, 1070, 1000], player)
      await this.drawRankDetailPanel(ctx, [54, 1010, 370, 1340], 'legend', '当前英雄', player.selectedLegend || '未知')
      await this.drawRankInfoPanel(ctx, [376, 1010, 720, 1340], 'crown', '等级', String(player.level ?? '未知'), `平台 ${formatPlatform(player.platform)}`)
      await this.drawRankStatusPanel(ctx, [724, 1010, 1070, 1340], player.currentState || (player.isOnline ? '在线' : '离线'))
      await this.writePng(canvas, filePath)
    })
  }

  async renderRankChange(player: RankRenderPlayer, oldScore: number, newScore: number, platform: string, isSeasonReset: boolean) {
    const key = `rank-change:${JSON.stringify({ player, oldScore, newScore, platform, isSeasonReset })}`
    return this.cached(key, 'rank_change_cards', `rank_change_${safeName(playerDisplayName(player))}_${Date.now()}.png`, async (filePath) => {
      const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT)
      const ctx = canvas.getContext('2d')
      this.drawRankBackground(ctx, CARD_WIDTH, CARD_HEIGHT)
      this.drawOuterFrame(ctx, CARD_WIDTH, CARD_HEIGHT)
      this.drawRankChangeHeader(ctx)
      this.drawTimeBar(ctx)
      await this.drawRankInfoPanel(ctx, [54, 360, 388, 670], 'player', '玩家', playerDisplayName(player))
      await this.drawRankInfoPanel(ctx, [402, 360, 720, 670], 'platform', '平台', formatPlatform(platform || player.platform))
      await this.drawRankBadgePanel(ctx, [734, 360, 1070, 670], '段位', rankDisplay(player), player.rankName, player.rankDiv)
      this.drawScoreChangePanel(ctx, oldScore, newScore, isSeasonReset)
      await this.drawRankDetailPanel(ctx, [54, 1010, 370, 1340], 'globe', '全球排名', rankPercent(player.globalRankPercent))
      await this.drawRankDetailPanel(ctx, [376, 1010, 720, 1340], 'legend', '当前英雄', player.selectedLegend || '未知')
      await this.drawRankStatusPanel(ctx, [724, 1010, 1070, 1340], player.currentState || (player.isOnline ? '在线' : '离线'))
      await this.writePng(canvas, filePath)
    })
  }

  async renderMapRotation(info: MapRotationInfo, mode: 'ranked' | 'battle_royale' = 'ranked') {
    const rotationMode = mode === 'battle_royale' ? info.battleRoyale : info.ranked
    const current = rotationMode.current
    if (!current) throw new Error('缺少当前地图轮换数据')
    const next = rotationMode.next
    const key = `map:${mode}:${JSON.stringify(rotationMode)}`
    return this.cached(key, 'map_cards', `map_rotation_${mode}.png`, async (filePath) => {
      const canvas = createCanvas(MAP_WIDTH, MAP_HEIGHT)
      const ctx = canvas.getContext('2d')
      await this.drawMapBackground(ctx, current, [0, 0, MAP_WIDTH, MAP_CURRENT_HEIGHT], 0.42)
      this.overlayRect(ctx, [0, 0, MAP_WIDTH, MAP_CURRENT_HEIGHT], [0, 0, 0, 80])
      this.drawHorizontalGradient(ctx, 0, MAP_CURRENT_HEIGHT, 190)
      this.drawMapCurrentSection(ctx, current, mode === 'battle_royale' ? '当前三人赛地图' : '当前排位地图')
      if (next) {
        await this.drawMapBackground(ctx, next, [0, MAP_CURRENT_HEIGHT, MAP_WIDTH, MAP_HEIGHT], 0.48)
        this.overlayRect(ctx, [0, MAP_CURRENT_HEIGHT, MAP_WIDTH, MAP_HEIGHT], [0, 0, 0, 94])
        this.drawHorizontalGradient(ctx, MAP_CURRENT_HEIGHT, MAP_HEIGHT - MAP_CURRENT_HEIGHT, 165)
        this.drawMapNextSection(ctx, next, mode === 'battle_royale' ? '下一张三人赛地图' : '下一张排位地图')
      } else {
        ctx.fillStyle = rgba([9, 12, 18, 255])
        ctx.fillRect(0, MAP_CURRENT_HEIGHT, MAP_WIDTH, MAP_HEIGHT - MAP_CURRENT_HEIGHT)
        drawTextWithShadow(ctx, 34, MAP_CURRENT_HEIGHT + 34, '暂无下一张地图', 30, true, [238, 242, 246, 255])
      }
      ctx.strokeStyle = rgba([255, 255, 255, 36])
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, MAP_CURRENT_HEIGHT)
      ctx.lineTo(MAP_WIDTH, MAP_CURRENT_HEIGHT)
      ctx.stroke()
      await this.writePng(canvas, filePath)
    })
  }

  async renderSeasonInfo(season: SeasonInfo) {
    const key = `season:${JSON.stringify(season)}`
    return this.cached(key, 'season_cards', `season_info_${season.seasonNumber ?? 'current'}.png`, async (filePath) => {
      const canvas = createCanvas(900, 320)
      const ctx = canvas.getContext('2d')
      await this.drawSeasonCard(ctx, season)
      await this.writePng(canvas, filePath)
    })
  }

  async renderPredatorInfo(predator: PredatorInfo) {
    const key = `predator:${JSON.stringify(predator)}`
    return this.cached(key, 'predator_cards', 'predator_info.png', async (filePath) => {
      const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT)
      const ctx = canvas.getContext('2d')
      if (!(await drawImageCover(ctx, assetPath('predator_template.png'), [0, 0, CARD_WIDTH, CARD_HEIGHT]))) {
        this.drawRankBackground(ctx, CARD_WIDTH, CARD_HEIGHT)
      }
      const query = nowText()
      const update = this.formatPredatorUpdateTime(predator.platforms) || '暂无'
      drawCenteredStrokedText(ctx, query, fitFont(ctx, query, 38, 28, 350, true), true, 636, 1053, 244, 318, [246, 241, 232, 255], 2)
      drawCenteredStrokedText(ctx, update, fitFont(ctx, update, 38, 28, 350, true), true, 636, 1053, 354, 426, [246, 241, 232, 255], 2)
      const rows: Record<string, [Box, Box]> = {
        PC: [[290, 535, 715, 648], [790, 536, 1078, 615]],
        PS4: [[290, 756, 715, 869], [790, 756, 1078, 835]],
        X1: [[290, 976, 715, 1089], [790, 976, 1078, 1055]],
        SWITCH: [[290, 1197, 715, 1311], [790, 1197, 1078, 1276]],
      }
      for (const [platform, [thresholdBox, countBox]] of Object.entries(rows)) {
        const stats = predator.platforms.find((entry) => entry.platform === platform)
        const threshold = stats ? `${formatNumber(stats.requiredRp)} RP` : '暂无'
        const count = stats ? formatNumber(stats.mastersCount) : '暂无'
        drawCenteredStrokedText(ctx, threshold, fitFont(ctx, threshold, 58, 36, thresholdBox[2] - thresholdBox[0] - 36, true), true, thresholdBox[0], thresholdBox[2], thresholdBox[1], thresholdBox[3], this.predatorThresholdFill(stats), 2)
        drawCenteredStrokedText(ctx, count, fitFont(ctx, count, 60, 34, countBox[2] - countBox[0] - 42, true), true, countBox[0], countBox[2], countBox[1], countBox[3], this.predatorMasterCountFill(stats), 2)
      }
      await this.writePng(canvas, filePath)
    })
  }

  async renderLeaderboard(entries: LeaderboardEntry[], options: LeaderboardRenderOptions) {
    const title = `Apex ${options.periodLabel}${options.directionLabel}榜`
    const key = `leaderboard:${JSON.stringify({ entries, options })}`
    return this.cached(key, 'leaderboard_cards', `leaderboard_${safeName(title)}.png`, async (filePath) => {
      const rowCount = Math.max(1, Math.min(10, entries.length || 1))
      const rowHeight = 118
      const rowGap = 14
      const footerHeight = 92
      const listTop = 366
      const height = Math.max(760, listTop + rowCount * (rowHeight + rowGap) + footerHeight)
      const canvas = createCanvas(CARD_WIDTH, height)
      const ctx = canvas.getContext('2d')
      this.drawRankBackground(ctx, CARD_WIDTH, height)
      this.drawOuterFrame(ctx, CARD_WIDTH, height)
      await this.drawLeaderboardHeader(ctx, title, options.periodRangeText)
      this.drawLeaderboardSummary(ctx, entries, options)

      let y = listTop
      const shownEntries = entries.slice(0, 10)
      for (let index = 0; index < shownEntries.length; index += 1) {
        this.drawLeaderboardRow(ctx, [54, y, CARD_WIDTH - 54, y + rowHeight], index + 1, shownEntries[index], options)
        y += rowHeight + rowGap
      }

      const footerText = entries.length > shownEntries.length
        ? `已展示前 ${shownEntries.length} 位，还有 ${entries.length - shownEntries.length} 位玩家未展示`
        : '统计范围与时间均按北京时间计算'
      drawCenteredStrokedText(ctx, footerText, fitFont(ctx, footerText, 28, 20, CARD_WIDTH - 150, true), true, 54, CARD_WIDTH - 54, height - 84, height - 40, [202, 210, 220, 255])
      await this.writePng(canvas, filePath)
    })
  }

  private helpCardSections(options: ImageRenderOptions): Array<[Box, string, Array<[string, string]>]> {
    return [
      [
        [54, 250, 1068, 500],
        '查询',
        [
          ['/apexrank 玩家 [平台]', '查询玩家段位、分数、在线状态'],
          ['/apex查询 /视奸', '中文别名，默认 PC，支持 uid:'],
          ['/apex查分 [玩家|uid:...]', '无参数查询绑定账号，也可临时指定目标'],
          ['/apex绑定 /apex解绑 /apex我的账号', '绑定默认 Apex 账号并查看绑定信息'],
        ],
      ],
      [
        [54, 520, 1068, 966],
        '监控',
        [
          ['/apexrankwatch 玩家 [平台]', '添加群内持续监控'],
          ['/apexranklist /apex列表', '查看本群监控列表'],
          ['/apexremark 玩家 [平台] [备注] /apex备注', '设置或清除监控备注'],
          ['/apexrankremove 玩家 [平台] /取消持续视奸', '移除指定玩家监控'],
          ['/apex日上分榜 /apex日掉分榜', '查看当前群北京时间自然日榜单'],
          ['/apex周上分榜 /apex周掉分榜', '查看当前群北京时间自然周榜单'],
          ['/apex监控 /持续视奸', '添加监控中文别名'],
        ],
      ],
      [
        [54, 986, 1068, 1436],
        '信息',
        [
          ['/map /地图 /排位地图', '排位地图轮换，默认输出图片'],
          ['/匹配地图', '三人赛地图轮换'],
          ['/apexpredator [平台] /apex猎杀 /猎杀', '大师数量与猎杀底分'],
          ['/apexseason [赛季号|current] /新赛季', '当前或历史赛季时间'],
          ['赛季关键词', '群消息包含赛季时自动回复'],
        ],
      ],
      [
        [54, 1456, 1068, 1716],
        '管理',
        [
          ['/apexblacklist add 玩家ID', '加入动态黑名单'],
          ['/apexblacklist list', '查看配置与动态黑名单'],
          ['/赛季关闭 /赛季开启', '管理本群赛季关键词回复'],
        ],
      ],
      [
        [54, 1736, 1068, 2296],
        '参数',
        this.helpParameterRows(options),
      ],
    ]
  }

  private helpParameterRows(options: ImageRenderOptions): Array<[string, string]> {
    const rows: Array<[string, string]> = [
      ['平台', 'PC / PS4 / X1 / SWITCH；PC 无数据会自动尝试其他平台'],
      ['UID', '使用 uid: 或 uuid: 前缀，例如 /apexrank uid:000000'],
      ['监控间隔', `${options.checkInterval ?? 2} 分钟`],
      ['最小有效分', `${options.minValidScore ?? 1} 分`],
      ['异常分数', '仅当高分掉到接近 0 分时判定为异常'],
      ['权限', '支持群白名单、用户黑名单、主人账号、私聊开关'],
    ]
    const totalBlacklist = (options.configBlacklistCount ?? 0) + (options.runtimeBlacklistCount ?? 0)
    if (totalBlacklist) rows.push(['黑名单', `配置 ${options.configBlacklistCount ?? 0} 个，动态 ${options.runtimeBlacklistCount ?? 0} 个`])
    if (options.queryBlocklistCount) rows.push(['禁止查询', `已设置 ${options.queryBlocklistCount} 个玩家ID`])
    return rows
  }

  private async drawHelpCardHeader(ctx: any) {
    const box: Box = [54, 54, 1068, 224]
    drawPanelBase(ctx, box, [12, 14, 19, 238], 150)
    await this.drawApexLogoBadge(ctx, [92, 80], 118)
    const title = 'Apex Rank Watch'
    const subtitle = 'Koishi 命令帮助卡 · 图片化速查'
    setFont(ctx, fitFont(ctx, title, 68, 48, 690, true), true)
    drawTextStroked(ctx, 250, centeredTextY(ctx, title, 70, 150), title, [248, 248, 244, 255], 2)
    const subtitleSize = fitFont(ctx, subtitle, 32, 24, 690, true)
    setFont(ctx, subtitleSize, true)
    drawTextStroked(ctx, 254, centeredTextY(ctx, subtitle, 150, 202), subtitle, [205, 212, 222, 255])
    ctx.fillStyle = rgba([236, 48, 52, 220])
    ctx.fillRect(780, 214, 928 - 780, 6)
  }

  private drawHelpSection(ctx: any, box: Box, title: string, rows: Array<[string, string]>) {
    drawPanelBase(ctx, box, [13, 16, 21, 238], 110)
    setFont(ctx, 38, true)
    drawTextStroked(ctx, box[0] + 34, box[1] + 24 + (textMetrics(ctx, title).ascent || 38), title, [246, 246, 241, 255], 2)
    ctx.fillStyle = rgba([232, 48, 52, 230])
    ctx.fillRect(box[0] + 34, box[1] + 74, 108, 6)

    const rowTop = box[1] + 92
    const available = Math.max(1, box[3] - rowTop - 22)
    const rowHeight = Math.max(66, Math.floor(available / Math.max(1, rows.length)))
    for (let index = 0; index < rows.length; index += 1) {
      const [command, desc] = rows[index]
      const top = rowTop + index * rowHeight
      if (top + 56 > box[3] - 16) break
      fillRoundedRect(ctx, [box[0] + 34, top + 12, box[0] + 46, top + 24], 3, [232, 48, 52, 235])
      const commandSize = fitFont(ctx, command, 29, 21, box[2] - box[0] - 102, true)
      setFont(ctx, commandSize, true)
      drawTextStroked(ctx, box[0] + 60, top + textMetrics(ctx, command).ascent, command, [250, 250, 246, 255])
      const descSize = fitFont(ctx, desc, 23, 17, box[2] - box[0] - 102)
      setFont(ctx, descSize)
      drawTextStroked(ctx, box[0] + 60, top + 34 + textMetrics(ctx, desc).ascent, desc, [172, 181, 194, 255])
    }
  }

  private async drawMonitorAddedHeader(ctx: any) {
    const box: Box = [54, 54, 1068, 224]
    drawPanelBase(ctx, box, [12, 14, 19, 238], 150)
    await this.drawApexLogoBadge(ctx, [92, 80], 118)
    const title = 'Apex 监控已添加'
    const subtitle = '当排位分数变化时会自动推送图片通知'
    const titleSize = fitFont(ctx, title, 66, 46, 690, true)
    setFont(ctx, titleSize, true)
    drawTextStroked(ctx, 250, centeredTextY(ctx, title, 70, 150), title, [248, 248, 244, 255], 2)
    const subtitleSize = fitFont(ctx, subtitle, 32, 22, 690, true)
    setFont(ctx, subtitleSize, true)
    drawTextStroked(ctx, 254, centeredTextY(ctx, subtitle, 150, 202), subtitle, [205, 212, 222, 255])
    ctx.fillStyle = rgba([236, 48, 52, 220])
    ctx.fillRect(790, 214, 148, 6)
  }

  private drawMonitorAddedStatus(ctx: any) {
    const timeBox: Box = [54, 244, 1068, 338]
    drawPanelBase(ctx, timeBox, [14, 17, 23, 240], 120)
    this.drawClockIcon(ctx, [92, 265], 28)
    setFont(ctx, 32, true)
    drawTextStroked(ctx, 176, centeredTextY(ctx, '时间:', timeBox[1], timeBox[3]), '时间:', [226, 226, 220, 255])
    const value = nowText()
    const valueSize = fitFont(ctx, value, 34, 24, 560, true)
    setFont(ctx, valueSize, true)
    drawTextStroked(ctx, 286, centeredTextY(ctx, value, timeBox[1], timeBox[3]), value, [244, 244, 239, 255])

    const statusBox: Box = [54, 358, 1068, 460]
    drawPanelBase(ctx, statusBox, [36, 16, 18, 242], 150)
    const status = '已加入本群排位监控'
    drawCenteredStrokedText(ctx, status, fitFont(ctx, status, 46, 30, 740, true), true, statusBox[0], statusBox[2], statusBox[1], statusBox[3], [255, 246, 236, 255], 2)
  }

  private drawMiniInfoPill(ctx: any, box: Box, label: string, value: string) {
    drawPanelBase(ctx, box, [13, 16, 21, 238], 92)
    drawCenteredStrokedText(ctx, label, fitFont(ctx, label, 24, 18, box[2] - box[0] - 34, true), true, box[0] + 12, box[2] - 12, box[1] + 12, box[1] + 38, [172, 181, 194, 255])
    drawCenteredStrokedText(ctx, String(value), fitFont(ctx, String(value), 30, 21, box[2] - box[0] - 34, true), true, box[0] + 12, box[2] - 12, box[1] + 38, box[3] - 10, [250, 250, 246, 255], 2)
  }

  private async drawMonitorAddedLegendPill(ctx: any, box: Box, legendName: string) {
    drawPanelBase(ctx, box, [13, 16, 21, 238], 92)
    const iconBox: Box = [box[0] + 22, box[1] + 14, box[0] + 100, box[1] + 92]
    drawIconOctagon(ctx, iconBox)
    if (!(await drawImageContain(ctx, assetPath('legends', legendIconName(legendName)), iconBox, true))) {
      this.drawRankIcon(ctx, 'legend', iconBox)
    }
    const textLeft = box[0] + 116
    const textRight = box[2] - 18
    const legendDisplayName = translate(legendName)
    drawCenteredStrokedText(ctx, '当前英雄', fitFont(ctx, '当前英雄', 23, 18, box[2] - box[0] - 134, true), true, textLeft, textRight, box[1] + 16, box[1] + 42, [172, 181, 194, 255])
    drawCenteredStrokedText(ctx, legendDisplayName, fitFont(ctx, legendDisplayName, 30, 21, box[2] - box[0] - 134, true), true, textLeft, textRight, box[1] + 44, box[3] - 12, [250, 250, 246, 255], 2)
  }

  private async drawMonitorListHeader(ctx: any, totalPlayers: number, options: ImageRenderOptions) {
    const box: Box = [54, 54, 1068, 224]
    drawPanelBase(ctx, box, [12, 14, 19, 238], 150)
    await this.drawApexLogoBadge(ctx, [92, 80], 118)
    const title = 'Apex 群监控列表'
    const subtitle = `${totalPlayers} 位玩家 · 每 ${options.checkInterval ?? 2} 分钟检测一次`
    drawCenteredStrokedText(ctx, title, fitFont(ctx, title, 66, 46, 690, true), true, 250, 940, 70, 150, [248, 248, 244, 255], 2)
    drawCenteredStrokedText(ctx, subtitle, fitFont(ctx, subtitle, 32, 23, 690, true), true, 254, 944, 150, 202, [205, 212, 222, 255])
    ctx.fillStyle = rgba([236, 48, 52, 220])
    ctx.fillRect(760, 214, 170, 6)
  }

  private drawMonitorListSummary(ctx: any, totalPlayers: number, options: ImageRenderOptions) {
    this.drawMiniInfoPill(ctx, [54, 244, 370, 338], '监控玩家', `${totalPlayers} 位`)
    this.drawMiniInfoPill(ctx, [388, 244, 734, 338], '检测间隔', `${options.checkInterval ?? 2} 分钟`)
    this.drawMiniInfoPill(ctx, [752, 244, 1068, 338], '最小有效分', `${options.minValidScore ?? 1} 分`)
  }

  private async drawMonitorListRow(ctx: any, box: Box, index: number, player: StoredPlayerRecord) {
    drawPanelBase(ctx, box, [13, 16, 21, 240], 92)
    const rankName = player.rankName || '未知'
    const rankDiv = player.rankDiv || 0
    const rankIcon = rankIconName(rankName, rankDiv)
    const iconBox: Box = [box[0] + 24, box[1] + 16, box[0] + 112, box[1] + 104]
    if (existsSync(assetPath('ranks', rankIcon))) {
      await drawImageContain(ctx, assetPath('ranks', rankIcon), iconBox)
      if (rankDiv && !rankIcon.includes('_') && !['master.png', 'predator.png'].includes(rankIcon)) {
        drawCenteredStrokedText(ctx, String(rankDiv), 28, true, iconBox[0] + 26, iconBox[2] - 26, iconBox[1] + 40, iconBox[3] - 18, [255, 255, 255, 255], 2)
      }
    } else {
      drawIconOctagon(ctx, iconBox)
      this.drawRankIcon(ctx, 'target', iconBox)
    }

    const displayName = player.remark ? `${player.remark} (${player.playerName})` : player.playerName || '未知玩家'
    const nameText = `${index}. ${displayName}`
    const metaText = `${formatPlatform(player.platform)} · ${this.formatRecordCheckedAt(player.lastChecked)} · ${formatRank(rankName, rankDiv)}`
    const textLeft = box[0] + 132
    setFont(ctx, fitFont(ctx, nameText, 34, 24, 390, true), true)
    drawTextStroked(ctx, textLeft, box[1] + 18 + textMetrics(ctx, nameText).ascent, nameText, [250, 250, 246, 255])
    setFont(ctx, fitFont(ctx, metaText, 25, 18, 430))
    drawTextStroked(ctx, textLeft, box[1] + 64 + textMetrics(ctx, metaText).ascent, metaText, [190, 198, 210, 255])

    const legendName = player.selectedLegend || '未知'
    const legendBox: Box = [box[0] + 600, box[1] + 22, box[0] + 674, box[1] + 96]
    drawIconOctagon(ctx, legendBox)
    if (!(await drawImageContain(ctx, assetPath('legends', legendIconName(legendName)), legendBox, true))) {
      this.drawRankIcon(ctx, 'legend', legendBox)
    }
    const legendDisplayName = translate(legendName)
    drawCenteredStrokedText(ctx, legendDisplayName, fitFont(ctx, legendDisplayName, 26, 18, 140, true), true, box[0] + 682, box[0] + 830, box[1] + 34, box[1] + 86, [236, 240, 246, 255])

    const scoreText = formatScore(player.rankScore)
    const scoreLeft = box[2] - 222
    drawCenteredStrokedText(ctx, '当前分数', 22, true, scoreLeft, box[2] - 28, box[1] + 18, box[1] + 48, [176, 184, 196, 255])
    drawCenteredStrokedText(ctx, scoreText, fitFont(ctx, scoreText, 46, 30, 190, true), true, scoreLeft, box[2] - 28, box[1] + 48, box[1] + 104, [250, 250, 246, 255], 2)
    ctx.fillStyle = rgba([221, 48, 52, 185])
    ctx.fillRect(scoreLeft + 28, box[3] - 18, box[2] - 58 - (scoreLeft + 28), 6)
  }

  private formatRecordCheckedAt(value: number) {
    const raw = Number(value)
    if (!Number.isFinite(raw) || raw <= 0) return '未知时间'
    const seconds = raw > 10_000_000_000 ? raw / 1000 : raw
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(seconds * 1000))
    const get = (type: string) => parts.find((part) => part.type === type)?.value || ''
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
  }

  private drawRankBackground(ctx: any, width: number, height: number) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, 'rgb(8, 9, 12)')
    gradient.addColorStop(1, 'rgb(22, 23, 26)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    ctx.strokeStyle = rgba([255, 255, 255, 18])
    ctx.lineWidth = 1
    for (let x = -260; x < width; x += 220) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x + 470, height)
      ctx.stroke()
    }
    ctx.fillStyle = rgba([230, 43, 45, 88])
    ctx.fillRect(250, 218, 622, 6)
    ctx.fillRect(420, 1358, 340, 7)
  }

  private drawOuterFrame(ctx: any, width: number, height: number) {
    const outer = [[36, 18], [width - 52, 18], [width - 18, 54], [width - 18, height - 68], [width - 60, height - 18], [54, height - 18], [18, height - 58], [18, 56]]
    const inner = [[50, 36], [width - 68, 36], [width - 36, 68], [width - 36, height - 82], [width - 76, height - 36], [68, height - 36], [36, height - 72], [36, 70]]
    this.drawPolyline(ctx, outer, [228, 48, 52, 255], 4, true)
    this.drawPolyline(ctx, inner, [112, 118, 126, 210], 2, true)
    ctx.strokeStyle = rgba([224, 45, 48, 170])
    ctx.lineWidth = 5
    for (const x of [70, 340, 764, 1014]) {
      ctx.beginPath()
      ctx.moveTo(x, 44)
      ctx.lineTo(x + 80, 44)
      ctx.stroke()
    }
    ctx.strokeStyle = rgba([210, 48, 52, 110])
    ctx.lineWidth = 2
    for (const y of [242, 688, 1000]) {
      ctx.beginPath()
      ctx.moveTo(58, y)
      ctx.lineTo(width - 58, y)
      ctx.stroke()
    }
  }

  private drawPolyline(ctx: any, points: number[][], color: Color, width: number, close = false) {
    ctx.strokeStyle = rgba(color)
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.moveTo(points[0][0], points[0][1])
    for (const [x, y] of points.slice(1)) ctx.lineTo(x, y)
    if (close) ctx.closePath()
    ctx.stroke()
  }

  private drawPlayerRankHeader(ctx: any) {
    drawPanelBase(ctx, [54, 54, CARD_WIDTH - 54, 224], [12, 14, 19, 238], 150)
    this.drawPlayerCardIcon(ctx, [94, 82, 220, 190])
    const title = 'Apex 玩家档案'
    const size = fitFont(ctx, title, 78, 50, CARD_WIDTH - 310, true)
    setFont(ctx, size, true)
    drawTextStroked(ctx, 260, centeredTextY(ctx, title, 68, 202), title, [248, 248, 244, 255], 2)
    ctx.fillStyle = rgba([236, 48, 52, 220])
    ctx.fillRect(508, 217, 112, 5)
  }

  private drawRankChangeHeader(ctx: any) {
    drawPanelBase(ctx, [54, 54, CARD_WIDTH - 54, 224], [12, 14, 19, 238], 150)
    this.drawChartIcon(ctx, [94, 82, 220, 190])
    const title = 'Apex 排位分数变化'
    const size = fitFont(ctx, title, 78, 50, CARD_WIDTH - 310, true)
    setFont(ctx, size, true)
    drawTextStroked(ctx, 260, centeredTextY(ctx, title, 68, 202), title, [248, 248, 244, 255], 2)
    ctx.fillStyle = rgba([236, 48, 52, 220])
    ctx.fillRect(508, 217, 112, 5)
  }

  private drawPlayerCardIcon(ctx: any, box: Box) {
    const [left, top, right, bottom] = box
    drawIconOctagon(ctx, box)
    const cx = (left + right) / 2
    const cy = (top + bottom) / 2
    ctx.fillStyle = rgba([230, 232, 229, 255])
    ctx.beginPath()
    ctx.ellipse(cx, cy - 20, 22, 22, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(cx, cy + 36, 54, 42, 0, Math.PI, 0)
    ctx.fill()
    ctx.fillRect(cx - 54, cy + 36, 108, 42)
    ctx.strokeStyle = rgba([238, 62, 66, 255])
    ctx.lineWidth = 8
    ctx.beginPath()
    ctx.moveTo(left + 18, bottom - 14)
    ctx.lineTo(right - 14, top + 18)
    ctx.stroke()
    ctx.fillStyle = rgba([238, 62, 66, 255])
    ctx.beginPath()
    ctx.moveTo(right - 14, top + 18)
    ctx.lineTo(right - 18, top + 50)
    ctx.lineTo(right - 46, top + 24)
    ctx.closePath()
    ctx.fill()
  }

  private drawTimeBar(ctx: any) {
    const box: Box = [54, 244, 1070, 338]
    drawPanelBase(ctx, box, [14, 17, 23, 240], 120)
    this.drawClockIcon(ctx, [92, 265], 28)
    setFont(ctx, 34, true)
    drawTextStroked(ctx, 176, centeredTextY(ctx, '时间:', box[1], box[3]), '时间:', [226, 226, 220, 255])
    const value = nowText()
    const size = fitFont(ctx, value, 37, 26, 600, true)
    setFont(ctx, size, true)
    drawTextStroked(ctx, 288, centeredTextY(ctx, value, box[1], box[3]), value, [244, 244, 239, 255])
  }

  private async drawLeaderboardHeader(ctx: any, title: string, periodRangeText: string) {
    const box: Box = [54, 54, 1068, 224]
    drawPanelBase(ctx, box, [12, 14, 19, 238], 150)
    this.drawChartIcon(ctx, [94, 82, 220, 190])
    drawCenteredStrokedText(ctx, title, fitFont(ctx, title, 62, 40, 690, true), true, 250, 940, 72, 148, [248, 248, 244, 255], 2)
    drawCenteredStrokedText(ctx, periodRangeText, fitFont(ctx, periodRangeText, 26, 18, 760, true), true, 240, 980, 150, 202, [205, 212, 222, 255])
    ctx.fillStyle = rgba([236, 48, 52, 220])
    ctx.fillRect(760, 214, 178, 6)
  }

  private drawLeaderboardSummary(ctx: any, entries: LeaderboardEntry[], options: LeaderboardRenderOptions) {
    this.drawMiniInfoPill(ctx, [54, 244, 370, 338], '上榜玩家', `${entries.length} 位`)
    this.drawMiniInfoPill(ctx, [388, 244, 734, 338], '统计周期', `${options.periodLabel}榜`)
    this.drawMiniInfoPill(ctx, [752, 244, 1068, 338], '榜单类型', `${options.directionLabel}榜`)
  }

  private drawLeaderboardRow(ctx: any, box: Box, index: number, entry: LeaderboardEntry, options: LeaderboardRenderOptions) {
    drawPanelBase(ctx, box, [13, 16, 21, 240], 92)
    const deltaText = options.directionLabel === '上分' ? `+${entry.netDelta}` : `-${Math.abs(entry.netDelta)}`
    const deltaColor: Color = options.directionLabel === '上分' ? [88, 210, 126, 255] : [238, 62, 66, 255]
    const nameText = `${index}. ${entry.displayName}`
    const metaText = `${formatPlatform(entry.platform)} · 当前分 ${entry.latestScore}`
    setFont(ctx, fitFont(ctx, nameText, 34, 22, 660, true), true)
    drawTextStroked(ctx, box[0] + 42, box[1] + 24 + textMetrics(ctx, nameText).ascent, nameText, [250, 250, 246, 255])
    setFont(ctx, fitFont(ctx, metaText, 24, 18, 520, false))
    drawTextStroked(ctx, box[0] + 44, box[1] + 72 + textMetrics(ctx, metaText).ascent, metaText, [190, 198, 210, 255])
    drawCenteredStrokedText(ctx, '净变化', 22, true, box[2] - 246, box[2] - 28, box[1] + 18, box[1] + 48, [176, 184, 196, 255])
    drawCenteredStrokedText(ctx, deltaText, fitFont(ctx, deltaText, 46, 28, 190, true), true, box[2] - 246, box[2] - 28, box[1] + 48, box[1] + 104, deltaColor, 2)
    ctx.fillStyle = rgba([221, 48, 52, 185])
    ctx.fillRect(box[2] - 218, box[3] - 18, 160, 6)
  }

  private async drawPlayerProfilePanel(ctx: any, box: Box, player: RankRenderPlayer) {
    drawPanelBase(ctx, box, [13, 16, 21, 240], 105)
    const avatar: Box = [box[0] + 38, box[1] + 48, box[0] + 192, box[1] + 202]
    drawIconOctagon(ctx, avatar)
    await drawImageContain(ctx, assetPath('default_user_avatar.png'), avatar, true)
    const textLeft = box[0] + 220
    const textRight = box[2] - 24
    drawCenteredStrokedText(ctx, '玩家信息', 30, true, textLeft, textRight, box[1] + 48, box[1] + 92, [190, 192, 196, 255])
    const name = playerDisplayName(player)
    drawCenteredStrokedText(ctx, name, fitFont(ctx, name, 54, 30, box[2] - box[0] - 245, true), true, textLeft, textRight, box[1] + 112, box[1] + 174, [250, 250, 246, 255], 2)
    const uid = player.uid ? `UID ${player.uid}` : 'UID 未知'
    drawCenteredStrokedText(ctx, uid, fitFont(ctx, uid, 27, 20, box[2] - box[0] - 245), false, textLeft, textRight, box[1] + 192, box[1] + 236, [170, 176, 186, 255])
    ctx.fillStyle = rgba([221, 48, 52, 185])
    ctx.fillRect(textLeft + 22, box[3] - 38, textRight - textLeft - 44, 6)
  }

  private drawPlayerScorePanel(ctx: any, box: Box, player: ApexPlayerStats) {
    drawPanelBase(ctx, box, [13, 15, 19, 244], 135)
    ctx.strokeStyle = rgba([154, 40, 44, 86])
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(box[0] + 362, box[1] + 24)
    ctx.lineTo(box[0] + 310, box[3] - 24)
    ctx.moveTo(box[2] - 362, box[1] + 24)
    ctx.lineTo(box[2] - 310, box[3] - 24)
    ctx.stroke()
    const score = formatScore(player.rankScore)
    const display = rankDisplay(player)
    const percent = rankPercent(player.globalRankPercent)
    drawCenteredStrokedText(ctx, '段位分数', 34, true, box[0], box[2], box[1] + 42, box[1] + 92, [190, 192, 196, 255])
    drawCenteredStrokedText(ctx, score, fitFont(ctx, score, 150, 96, 620, true), true, box[0] + 160, box[2] - 160, box[1] + 98, box[1] + 230, [250, 250, 246, 255], 2)
    const left = box[0] + 34
    const right = box[2] - 34
    drawCenteredStrokedText(ctx, '当前段位', 28, true, left, left + 300, box[3] - 76, box[3] - 38, [190, 192, 196, 255])
    drawCenteredStrokedText(ctx, display, fitFont(ctx, display, 38, 26, 300, true), true, left + 250, left + 570, box[3] - 80, box[3] - 34, [250, 250, 246, 255], 2)
    const rankText = percent && percent !== '未知' ? `全球前 ${percent}` : '全球排名未知'
    drawCenteredStrokedText(ctx, rankText, fitFont(ctx, rankText, 34, 22, 250, true), true, right - 280, right, box[3] - 82, box[3] - 34, [214, 218, 224, 255])
    ctx.fillStyle = rgba([221, 48, 52, 185])
    ctx.fillRect(box[0] + 24, box[3] - 28, 272, 6)
    ctx.fillRect(box[2] - 296, box[3] - 28, 272, 6)
  }

  private async drawRankInfoPanel(ctx: any, box: Box, icon: string, label: string, value: string, secondary = '') {
    drawPanelBase(ctx, box, [13, 16, 21, 240], 105)
    const centerX = (box[0] + box[2]) / 2
    const iconBox: Box = [centerX - 58, box[1] + 48, centerX + 58, box[1] + 164]
    drawIconOctagon(ctx, iconBox)
    if (icon === 'player') {
      await drawImageContain(ctx, assetPath('default_user_avatar.png'), iconBox, true)
    } else {
      this.drawRankIcon(ctx, icon, iconBox)
    }
    const valueBottom = secondary ? box[3] - 58 : box[3] - 26
    drawCenteredStrokedText(ctx, label, 34, true, box[0], box[2], box[1] + 178, box[1] + 224, [190, 192, 196, 255])
    drawCenteredStrokedText(ctx, value, fitFont(ctx, value, 42, 24, box[2] - box[0] - 56, true), true, box[0] + 18, box[2] - 18, box[1] + 232, valueBottom, [250, 250, 246, 255])
    if (secondary) {
      drawCenteredStrokedText(ctx, secondary, fitFont(ctx, secondary, 27, 20, box[2] - box[0] - 56, true), true, box[0] + 22, box[2] - 22, box[3] - 58, box[3] - 22, [207, 211, 218, 255])
    }
  }

  private async drawRankBadgePanel(ctx: any, box: Box, label: string, value: string, rankName: string, rankDiv: number, secondary = '') {
    drawPanelBase(ctx, box, [13, 16, 21, 240], 105)
    const centerX = (box[0] + box[2]) / 2
    const iconName = rankIconName(rankName, rankDiv)
    const iconPath = assetPath('ranks', iconName)
    if (existsSync(iconPath)) {
      await drawImageContain(ctx, iconPath, [centerX - 92, box[1] + 24, centerX + 92, box[1] + 178])
      if (rankDiv && !iconName.includes('_') && !['master.png', 'predator.png'].includes(iconName)) {
        drawCenteredStrokedText(ctx, String(rankDiv), 42, true, centerX - 36, centerX + 36, box[1] + 84, box[1] + 142, [255, 255, 255, 255], 2)
      }
    } else {
      this.drawRankDiamond(ctx, [centerX, box[1] + 110], rankDiv)
    }
    const labelTop = secondary ? box[1] + 176 : box[1] + 178
    const labelBottom = secondary ? box[1] + 216 : box[1] + 224
    const valueTop = secondary ? box[1] + 214 : box[1] + 232
    const valueBottom = secondary ? box[1] + 268 : box[3] - 26
    const valueSize = secondary ? 42 : 47
    drawCenteredStrokedText(ctx, label, 34, true, box[0], box[2], labelTop, labelBottom, [190, 192, 196, 255])
    drawCenteredStrokedText(ctx, value, fitFont(ctx, value, valueSize, 30, box[2] - box[0] - 50, true), true, box[0], box[2], valueTop, valueBottom, [250, 250, 246, 255])
    if (secondary) {
      drawCenteredStrokedText(ctx, secondary, fitFont(ctx, secondary, 27, 20, box[2] - box[0] - 60, true), true, box[0] + 30, box[2] - 30, box[1] + 266, box[3] - 18, [214, 218, 224, 255])
    }
  }

  private drawScoreChangePanel(ctx: any, oldScore: number, newScore: number, isSeasonReset: boolean) {
    const box: Box = [52, 690, 1070, 992]
    drawPanelBase(ctx, box, [13, 15, 19, 244], 130)
    ctx.strokeStyle = rgba([154, 40, 44, 86])
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(424, 716)
    ctx.lineTo(365, 966)
    ctx.moveTo(698, 716)
    ctx.lineTo(758, 966)
    ctx.stroke()
    const diff = newScore - oldScore
    const color: Color = diff > 0 ? [88, 210, 126, 255] : [238, 62, 66, 255]
    const direction = isSeasonReset ? '赛季重置' : diff > 0 ? '上升' : '下降'
    const sign = diff > 0 ? `+${diff}` : String(diff)
    const desc = isSeasonReset ? `下降 ${Math.abs(diff)} 分` : `${direction} ${Math.abs(diff)} 分`
    drawCenteredStrokedText(ctx, '原分数', 34, true, 74, 404, 724, 780, [198, 202, 207, 255])
    drawCenteredStrokedText(ctx, formatScore(oldScore), fitFont(ctx, formatScore(oldScore), 94, 62, 320, true), true, 74, 404, 794, 906, [248, 248, 244, 255], 2)
    drawCenteredStrokedText(ctx, '当前分数', 34, true, 718, 1048, 724, 780, [198, 202, 207, 255])
    drawCenteredStrokedText(ctx, formatScore(newScore), fitFont(ctx, formatScore(newScore), 94, 62, 320, true), true, 718, 1048, 794, 906, [248, 248, 244, 255], 2)
    this.drawDeltaArrows(ctx, [561, 743], diff)
    drawCenteredStrokedText(ctx, sign, fitFont(ctx, sign, 76, 46, 220, true), true, 448, 674, 790, 870, color, 2)
    drawCenteredStrokedText(ctx, desc, fitFont(ctx, desc, 38, 26, 248, true), true, 430, 692, 882, 944, color, 2)
    ctx.fillStyle = rgba([221, 48, 52, 185])
    ctx.fillRect(118, 944, 264, 6)
    ctx.fillRect(740, 944, 262, 6)
  }

  private async drawRankDetailPanel(ctx: any, box: Box, icon: string, label: string, value: string, subtitle = '') {
    drawPanelBase(ctx, box, [13, 16, 21, 240], 100)
    const centerX = (box[0] + box[2]) / 2
    const iconBox: Box = [centerX - 58, box[1] + 48, centerX + 58, box[1] + 164]
    drawIconOctagon(ctx, iconBox)
    if (icon === 'legend') {
      const legendPath = assetPath('legends', legendIconName(value))
      if (!(await drawImageContain(ctx, legendPath, iconBox, true))) this.drawRankIcon(ctx, icon, iconBox)
    } else {
      this.drawRankIcon(ctx, icon, iconBox)
    }
    const labelTop = subtitle ? box[1] + 174 : box[1] + 178
    const labelBottom = subtitle ? box[1] + 216 : box[1] + 226
    const valueTop = subtitle ? box[1] + 216 : box[1] + 238
    const valueBottom = subtitle ? box[1] + 272 : box[3] - 32
    drawCenteredStrokedText(ctx, label, 32, true, box[0], box[2], labelTop, labelBottom, [190, 192, 196, 255])
    const displayValue = icon === 'legend' ? translate(value) : value
    drawCenteredStrokedText(ctx, displayValue, fitFont(ctx, displayValue, 48, 30, box[2] - box[0] - 56, true), true, box[0] + 22, box[2] - 22, valueTop, valueBottom, [250, 250, 246, 255])
    if (subtitle) drawCenteredStrokedText(ctx, subtitle, fitFont(ctx, subtitle, 26, 18, box[2] - box[0] - 56, true), true, box[0] + 22, box[2] - 22, box[1] + 270, box[3] - 22, [207, 211, 218, 255])
  }

  private async drawRankStatusPanel(ctx: any, box: Box, status: string) {
    if (await drawImageContain(ctx, assetPath('status', statusAssetName(status)), box)) return
    drawPanelBase(ctx, box, [13, 16, 21, 240], 100)
    const centerX = (box[0] + box[2]) / 2
    const iconBox: Box = [centerX - 58, box[1] + 48, centerX + 58, box[1] + 164]
    drawIconOctagon(ctx, iconBox)
    this.drawRankIcon(ctx, 'target', iconBox)
    drawCenteredStrokedText(ctx, '当前状态', 32, true, box[0], box[2], box[1] + 178, box[1] + 226, [190, 192, 196, 255])
    const button: Box = [box[0] + 58, box[1] + 238, box[2] - 58, box[1] + 320]
    fillRoundedRect(ctx, button, 8, [186, 42, 42, 245], [255, 98, 84, 230], 2)
    drawCenteredStrokedText(ctx, status || '未知', fitFont(ctx, status || '未知', 38, 24, 206, true), true, button[0], button[2], button[1], button[3], [255, 247, 235, 255])
  }

  private drawRankIcon(ctx: any, icon: string, box: Box) {
    const [left, top, right, bottom] = box
    const cx = (left + right) / 2
    const cy = (top + bottom) / 2
    ctx.strokeStyle = rgba([244, 241, 235, 255])
    ctx.fillStyle = rgba([244, 241, 235, 255])
    ctx.lineWidth = 5
    if (icon === 'player') {
      ctx.beginPath()
      ctx.ellipse(cx, cy - 18, 20, 20, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.ellipse(cx, cy + 36, 52, 40, 0, Math.PI, 0)
      ctx.fill()
      ctx.fillRect(cx - 52, cy + 36, 104, 40)
    } else if (icon === 'platform') {
      this.drawMonitorIcon(ctx, [cx, cy], 76)
    } else if (icon === 'globe') {
      ctx.beginPath()
      ctx.ellipse(cx, cy, 42, 42, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.ellipse(cx, cy, 22, 42, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - 42, cy)
      ctx.lineTo(cx + 42, cy)
      ctx.moveTo(cx, cy - 42)
      ctx.lineTo(cx, cy + 42)
      ctx.stroke()
    } else if (icon === 'legend') {
      ctx.beginPath()
      ctx.ellipse(cx, cy + 12, 30, 28, 0, 0, Math.PI * 2)
      ctx.stroke()
      this.drawPolyline(ctx, [[cx - 38, cy - 8], [cx - 24, cy - 44], [cx - 12, cy - 16], [cx, cy - 54], [cx + 12, cy - 16], [cx + 28, cy - 44], [cx + 38, cy - 8]], [244, 241, 235, 255], 8)
    } else if (icon === 'target') {
      ctx.beginPath()
      ctx.ellipse(cx, cy, 38, 38, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.ellipse(cx, cy, 15, 15, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - 56, cy)
      ctx.lineTo(cx + 56, cy)
      ctx.moveTo(cx, cy - 56)
      ctx.lineTo(cx, cy + 56)
      ctx.stroke()
    } else if (icon === 'crown') {
      this.drawPolyline(ctx, [[cx - 48, cy + 34], [cx - 38, cy - 26], [cx - 14, cy + 4], [cx, cy - 42], [cx + 14, cy + 4], [cx + 38, cy - 26], [cx + 48, cy + 34]], [244, 241, 235, 255], 8)
      fillRoundedRect(ctx, [cx - 44, cy + 28, cx + 44, cy + 50], 4, [244, 241, 235, 255])
    }
  }

  private drawMonitorIcon(ctx: any, [cx, cy]: number[], size: number) {
    const width = size
    const height = size * 0.58
    fillRoundedRect(ctx, [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2], 6, [0, 0, 0, 0], [244, 241, 235, 255], 7)
    ctx.strokeStyle = rgba([244, 241, 235, 255])
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.moveTo(cx, cy + height / 2)
    ctx.lineTo(cx, cy + height / 2 + 22)
    ctx.moveTo(cx - 34, cy + height / 2 + 24)
    ctx.lineTo(cx + 34, cy + height / 2 + 24)
    ctx.stroke()
  }

  private drawChartIcon(ctx: any, box: Box) {
    const [left, top, right, bottom] = box
    ctx.strokeStyle = rgba([230, 232, 229, 255])
    ctx.lineWidth = 3
    ctx.strokeRect(left, top, right - left, bottom - top)
    ctx.strokeStyle = rgba([230, 232, 229, 70])
    ctx.lineWidth = 2
    for (let index = 1; index < 4; index += 1) {
      const x = left + (right - left) * index / 4
      const y = top + (bottom - top) * index / 4
      ctx.beginPath()
      ctx.moveTo(x, top)
      ctx.lineTo(x, bottom)
      ctx.moveTo(left, y)
      ctx.lineTo(right, y)
      ctx.stroke()
    }
    this.drawPolyline(ctx, [[left + 18, bottom - 18], [left + 46, bottom - 52], [left + 72, bottom - 28], [left + 100, top + 42], [right - 10, top + 16]], [238, 62, 66, 255], 9)
    ctx.fillStyle = rgba([238, 62, 66, 255])
    ctx.beginPath()
    ctx.moveTo(right - 10, top + 16)
    ctx.lineTo(right - 12, top + 52)
    ctx.lineTo(right - 42, top + 24)
    ctx.closePath()
    ctx.fill()
  }

  private drawClockIcon(ctx: any, [cx, cy]: number[], radius: number) {
    ctx.strokeStyle = rgba([238, 62, 66, 255])
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.ellipse(cx, cy, radius, radius, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx, cy - 18)
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + 18, cy + 10)
    ctx.stroke()
  }

  private drawRankDiamond(ctx: any, [cx, cy]: number[], rankDiv: number) {
    ctx.fillStyle = rgba([45, 47, 122, 235])
    ctx.strokeStyle = rgba([184, 188, 255, 255])
    ctx.lineWidth = 5
    const outer = [[cx, cy - 74], [cx + 82, cy], [cx, cy + 74], [cx - 82, cy]]
    this.fillPolygon(ctx, outer, [45, 47, 122, 235])
    this.drawPolyline(ctx, outer, [158, 164, 255, 255], 5, true)
    const inner = [[cx, cy - 52], [cx + 58, cy], [cx, cy + 52], [cx - 58, cy]]
    this.fillPolygon(ctx, inner, [35, 31, 84, 245])
    if (rankDiv) drawCenteredStrokedText(ctx, String(rankDiv), 58, true, cx - 48, cx + 48, cy - 42, cy + 48, [255, 255, 255, 255], 2)
  }

  private fillPolygon(ctx: any, points: number[][], color: Color) {
    ctx.fillStyle = rgba(color)
    ctx.beginPath()
    ctx.moveTo(points[0][0], points[0][1])
    for (const [x, y] of points.slice(1)) ctx.lineTo(x, y)
    ctx.closePath()
    ctx.fill()
  }

  private drawDeltaArrows(ctx: any, [cx, cy]: number[], diff: number) {
    const color: Color = diff > 0 ? [88, 210, 126, 255] : [238, 62, 66, 255]
    const direction = diff > 0 ? -1 : 1
    for (const offset of [0, 38]) {
      const y = cy + offset * direction
      const points = diff > 0
        ? [[cx, y - 30], [cx - 42, y + 16], [cx - 22, y + 16], [cx, y - 7], [cx + 22, y + 16], [cx + 42, y + 16]]
        : [[cx, y + 30], [cx - 42, y - 16], [cx - 22, y - 16], [cx, y + 7], [cx + 22, y - 16], [cx + 42, y - 16]]
      this.drawPolyline(ctx, points, color, 10)
    }
  }

  private async drawMapBackground(ctx: any, entry: MapRotationEntry, box: Box, focusY: number) {
    const mapPath = assetPath('maps', mapAssetName(entry.mapName))
    if (await drawImageCover(ctx, mapPath, box, focusY)) return
    const gradient = ctx.createLinearGradient(box[0], box[1], box[2], box[3])
    gradient.addColorStop(0, '#1c2430')
    gradient.addColorStop(1, '#404858')
    ctx.fillStyle = gradient
    ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1])
  }

  private overlayRect(ctx: any, box: Box, color: Color) {
    ctx.fillStyle = rgba(color)
    ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1])
  }

  private drawHorizontalGradient(ctx: any, y: number, height: number, alpha: number) {
    const gradient = ctx.createLinearGradient(0, 0, MAP_WIDTH, 0)
    gradient.addColorStop(0, rgba([0, 0, 0, alpha]))
    gradient.addColorStop(0.58, rgba([0, 0, 0, Math.round(alpha * 0.14)]))
    gradient.addColorStop(1, rgba([0, 0, 0, 0]))
    ctx.fillStyle = gradient
    ctx.fillRect(0, y, MAP_WIDTH, height)
  }

  private drawMapCurrentSection(ctx: any, current: MapRotationEntry, label: string) {
    const title = displayMapName(current)
    drawTextWithShadow(ctx, 34, 52, label, 27, true, [231, 236, 243, 255])
    drawTextWithShadow(ctx, 34, 118, title, fitFont(ctx, title, 61, 36, MAP_WIDTH - 330, true), true, [255, 255, 255, 255])
    drawTextWithShadow(ctx, 36, 164, `本轮时间：${rotationRange(current)}`, 28, false, [238, 242, 246, 255])
    this.drawRemainingRing(ctx, [MAP_WIDTH - 150, 36], remainingForCard(current), current)
  }

  private drawMapNextSection(ctx: any, next: MapRotationEntry, label: string) {
    const title = displayMapName(next)
    const y = MAP_CURRENT_HEIGHT
    const timeText = `下轮时间：${rotationRange(next)}`
    const nameSize = fitFont(ctx, title, 42, 30, MAP_WIDTH - 460, true)
    const timeSize = fitFont(ctx, timeText, 25, 18, MAP_WIDTH - 420)
    setFont(ctx, timeSize)
    const timeX = Math.max(34, MAP_WIDTH - 34 - textMetrics(ctx, timeText).width)
    drawTextWithShadow(ctx, 34, y + 39, label, 24, true, [219, 226, 235, 255])
    drawTextWithShadow(ctx, 34, y + 86, title, nameSize, true, [255, 255, 255, 255])
    drawTextWithShadow(ctx, timeX, y + 70, timeText, timeSize, false, [238, 242, 246, 255])
  }

  private drawRemainingRing(ctx: any, [x, y]: number[], value: string, entry: MapRotationEntry) {
    const size = 112
    ctx.fillStyle = rgba([0, 0, 0, 156])
    ctx.strokeStyle = rgba([255, 255, 255, 34])
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.ellipse(x + size / 2, y + size / 2, size / 2, size / 2, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.strokeStyle = rgba([49, 191, 139, 255])
    ctx.lineWidth = 10
    ctx.beginPath()
    ctx.arc(x + size / 2, y + size / 2, size / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remainingFraction(entry))
    ctx.stroke()
    const textSize = fitFont(ctx, value, 28, 18, size - 22, true)
    setFont(ctx, textSize, true)
    drawTextWithShadow(ctx, x + (size - textMetrics(ctx, value).width) / 2, y + 62, value, textSize, true, [255, 255, 255, 255])
    setFont(ctx, 19)
    ctx.fillStyle = rgba([220, 226, 233, 230])
    ctx.fillText('剩余', x + (size - textMetrics(ctx, '剩余').width) / 2, y + 88)
  }

  private async drawSeasonCard(ctx: any, season: SeasonInfo) {
    const width = 900
    const height = 320
    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, 'rgb(12,13,17)')
    gradient.addColorStop(1, 'rgb(46,20,22)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = rgba([94, 15, 20, 215])
    this.fillPolygon(ctx, [[560, 0], [width, 0], [width, height], [690, height]], [94, 15, 20, 215])
    this.fillPolygon(ctx, [[716, 0], [width, 0], [width, 136], [794, 94]], [236, 50, 42, 205])
    this.fillPolygon(ctx, [[0, 0], [286, 0], [196, height], [0, height]], [18, 21, 27, 210])
    ctx.fillStyle = rgba([216, 35, 42, 255])
    ctx.fillRect(0, 0, width, 9)
    ctx.fillStyle = rgba([6, 7, 10, 175])
    ctx.fillRect(0, height - 56, width, 56)
    ctx.strokeStyle = rgba([255, 255, 255, 12])
    ctx.lineWidth = 2
    for (let x = 120; x < width; x += 168) {
      ctx.beginPath()
      ctx.moveTo(x, 18)
      ctx.lineTo(x - 76, height - 16)
      ctx.stroke()
    }
    await this.drawApexLogoBadge(ctx, [34, 28], 92)
    const label = season.seasonNumber !== null ? `S${season.seasonNumber}${season.seasonName ? ` · ${season.seasonName}` : ''}` : season.seasonName || '未知赛季'
    const endTime = toShanghaiText(season.endIso) || season.endDate || '未知'
    const startTime = toShanghaiText(season.startIso) || season.startDate || '未知'
    const remaining = this.formatRemaining(season.endIso) || '未知'
    drawTextWithShadow(ctx, 146, 31 + 18, 'APEX LEGENDS', 18, false, [216, 35, 42, 255])
    drawTextWithShadow(ctx, 146, 54 + 24, '当前赛季', 24, true, [236, 239, 244, 255])
    drawTextWithShadow(ctx, 146, 88 + 50, label, fitFont(ctx, label, 62, 38, width - 330, true), true, [255, 255, 255, 255])
    const status = (season as any).statusText || '未知'
    fillRoundedRect(ctx, [728, 34, 850, 72], 8, [232, 43, 45, 245])
    drawCenteredStrokedText(ctx, status, fitFont(ctx, status, 24, 18, 120, true), true, 728, 850, 34, 72, [255, 255, 255, 255], 0)
    const panel: Box = [34, 164, 866, 250]
    fillRoundedRect(ctx, panel, 8, [15, 18, 24, 238], [232, 43, 45, 160], 2)
    fillRoundedRect(ctx, [34, 164, 48, 250], 7, [216, 35, 42, 255])
    drawTextWithShadow(ctx, 64, centeredTextY(ctx, '赛季结束时间', 164, 250), '赛季结束时间', 25, true, [232, 215, 191, 255])
    const timeSize = fitFont(ctx, endTime, 46, 30, width - 405, true)
    setFont(ctx, timeSize, true)
    drawTextWithShadow(ctx, centeredTextX(ctx, endTime, 304, 846), centeredTextY(ctx, endTime, 164, 250), endTime, timeSize, true, [255, 246, 228, 255])
    fillRoundedRect(ctx, [58, 270, 578, 284], 7, [50, 55, 64, 255])
    this.drawProgressBar(ctx, [58, 270, 578, 284], this.seasonProgress(season), [216, 35, 42, 255], [240, 174, 72, 255])
    ctx.fillStyle = rgba([191, 198, 209, 235])
    setFont(ctx, 18)
    ctx.fillText(`开始 ${startTime}`, 58, 306)
    drawTextWithShadow(ctx, 620, 289, `剩余 ${remaining}`, 22, false, [255, 235, 204, 255])
    ctx.fillStyle = rgba([178, 190, 204, 230])
    setFont(ctx, 18)
    ctx.fillText(`来源 ${season.source}`, 620, 314)
  }

  private async drawApexLogoBadge(ctx: any, [x, y]: number[], size: number) {
    ctx.fillStyle = rgba([7, 9, 13, 238])
    ctx.beginPath()
    ctx.ellipse(x + size / 2, y + size / 2, size / 2, size / 2, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = rgba([232, 43, 45, 255])
    ctx.lineWidth = 3
    ctx.stroke()
    const logo = assetPath('logo.png')
    if (await drawImageCover(ctx, logo, [x + 6, y + 6, x + size - 6, y + size - 6], 0.5)) return
    drawTextWithShadow(ctx, x + size * 0.28, y + size * 0.72, 'A', 54, true, [232, 43, 45, 255])
  }

  private drawProgressBar(ctx: any, box: Box, progress: number, start: Color, end: Color) {
    const width = Math.max(0, Math.trunc((box[2] - box[0]) * Math.min(1, Math.max(0, progress))))
    if (!width) return
    const gradient = ctx.createLinearGradient(box[0], box[1], box[0] + width, box[1])
    gradient.addColorStop(0, rgba(start))
    gradient.addColorStop(1, rgba(end))
    ctx.save()
    roundedRect(ctx, [box[0], box[1], box[0] + width, box[3]], (box[3] - box[1]) / 2)
    ctx.clip()
    ctx.fillStyle = gradient
    ctx.fillRect(box[0], box[1], width, box[3] - box[1])
    ctx.restore()
  }

  private seasonProgress(season: SeasonInfo) {
    const start = new Date(season.startIso).getTime()
    const end = new Date(season.endIso).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
    return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)))
  }

  private formatRemaining(endIso: string) {
    const end = new Date(endIso).getTime()
    if (!Number.isFinite(end)) return ''
    const diff = Math.max(0, end - Date.now())
    const minutes = Math.trunc(diff / 60_000)
    const days = Math.trunc(minutes / 1440)
    const hours = Math.trunc((minutes % 1440) / 60)
    const mins = minutes % 60
    if (days) return `${days}天${hours}小时`
    if (hours) return `${hours}小时${mins}分钟`
    return `${mins}分钟`
  }

  private formatPredatorUpdateTime(platforms: PredatorPlatformInfo[]) {
    const timestamp = platforms.find((entry) => entry.updateTimestamp)?.updateTimestamp
    if (!timestamp) return ''
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(timestamp * 1000))
  }

  private predatorThresholdFill(stats?: PredatorPlatformInfo): Color {
    if (!stats || stats.requiredRp === null) return [246, 241, 232, 255]
    return stats.requiredRp <= 16000 ? [88, 210, 126, 255] : [158, 31, 36, 255]
  }

  private predatorMasterCountFill(stats?: PredatorPlatformInfo): Color {
    if (!stats || stats.mastersCount === null) return [246, 241, 232, 255]
    return stats.mastersCount < 750 ? [88, 210, 126, 255] : [158, 31, 36, 255]
  }

  private async cached(key: string, dirName: string, fileName: string, render: (filePath: string) => Promise<void>) {
    const cached = this.cache.get(key)
    if (cached && existsSync(cached.path) && Date.now() - cached.savedAt <= CACHE_TTL_MS) return cached.path
    const filePath = resolve(this.dataDir, dirName, fileName)
    await mkdir(dirname(filePath), { recursive: true })
    await render(filePath)
    this.cache.set(key, { path: filePath, savedAt: Date.now() })
    return filePath
  }

  private async writePng(canvas: any, filePath: string) {
    await writeFile(filePath, canvas.toBuffer('image/png'))
  }
}
