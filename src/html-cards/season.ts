import type { SeasonInfo } from '../shared'
import type {
  HtmlCardDocument,
  HtmlCardKeyValueBlock,
  HtmlCardMetaItem,
  HtmlCardSectionBlock,
} from './types'

const UNKNOWN_TEXT = '未知'
const REFERENCE_NOTE = '第三方数据仅供参考，请以游戏内实际时间为准。'
const BEIJING_TIMEZONE = 'Asia/Shanghai'

function hasDisplayText(value: string | null | undefined): value is string {
  const text = String(value || '').trim()
  return !!text && text !== UNKNOWN_TEXT
}

function normalizeDisplayText(value: string | null | undefined) {
  return hasDisplayText(value) ? value.trim() : UNKNOWN_TEXT
}

function formatSeasonLabel(season: SeasonInfo) {
  if (season.seasonNumber === null) {
    return hasDisplayText(season.seasonName) ? season.seasonName.trim() : UNKNOWN_TEXT
  }

  return hasDisplayText(season.seasonName)
    ? `S${season.seasonNumber} · ${season.seasonName.trim()}`
    : `S${season.seasonNumber}`
}

function formatSeasonNumberValue(season: SeasonInfo) {
  return season.seasonNumber === null ? UNKNOWN_TEXT : `S${season.seasonNumber}`
}

function formatBeijingTime(isoValue: string) {
  if (!isoValue) return ''
  const date = new Date(isoValue)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-')
}

function formatRemaining(endIso: string) {
  if (!endIso) return UNKNOWN_TEXT
  const end = new Date(endIso).getTime()
  if (!Number.isFinite(end)) return UNKNOWN_TEXT

  let diff = end - Date.now()
  if (diff <= 0) return '已结束'

  const day = Math.floor(diff / 86_400_000)
  diff -= day * 86_400_000
  const hour = Math.floor(diff / 3_600_000)
  diff -= hour * 3_600_000
  const minute = Math.floor(diff / 60_000)

  const parts: string[] = []
  if (day) parts.push(`${day} 天`)
  if (hour) parts.push(`${hour} 小时`)
  if (minute || !parts.length) parts.push(`${minute} 分钟`)
  return parts.join(' ')
}

function formatProgress(startIso: string, endIso: string) {
  if (!startIso || !endIso) return UNKNOWN_TEXT

  const start = new Date(startIso).getTime()
  const end = new Date(endIso).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return UNKNOWN_TEXT

  const progress = Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100))
  return `${progress.toFixed(2)}%`
}

function buildSeasonMetaItems(season: SeasonInfo): HtmlCardMetaItem[] {
  return [
    { label: '赛季编号', value: formatSeasonNumberValue(season) },
    { label: '状态', value: normalizeDisplayText(season.statusText) },
    { label: '数据来源', value: normalizeDisplayText(season.source) },
    { label: '更新时间提示', value: normalizeDisplayText(season.updateTimeHint) },
  ]
}

function buildSeasonTimeRows(season: SeasonInfo): HtmlCardKeyValueBlock['rows'] {
  const startTime = formatBeijingTime(season.startIso)
  const endTime = formatBeijingTime(season.endIso)

  return [
    {
      label: startTime ? '开始时间（北京时间）' : '开始时间',
      value: startTime || normalizeDisplayText(season.startDate),
    },
    {
      label: endTime ? '结束时间（北京时间）' : '结束时间',
      value: endTime || normalizeDisplayText(season.endDate),
    },
    {
      label: '剩余时间',
      value: formatRemaining(season.endIso),
    },
    {
      label: '进度',
      value: formatProgress(season.startIso, season.endIso),
    },
  ]
}

function buildSeasonDetailBlock(season: SeasonInfo): HtmlCardSectionBlock {
  return {
    type: 'section',
    title: '说明',
    items: [
      {
        title: '时区信息',
        description: normalizeDisplayText(season.timezone),
      },
      {
        title: '数据说明',
        description: REFERENCE_NOTE,
      },
    ],
  }
}

// Shared season card builder used by the two live season entries:
// 1. /apexseason [season:string]
// 2. 赛季关键词自动回复 middleware
export function buildSeasonCardDocument(season: SeasonInfo): HtmlCardDocument {
  const blocks: HtmlCardDocument['blocks'] = [
    {
      type: 'key-value',
      rows: buildSeasonTimeRows(season),
    },
    buildSeasonDetailBlock(season),
  ]

  return {
    title: 'Apex 赛季时间信息',
    subtitle: `当前赛季：${formatSeasonLabel(season)}`,
    metaItems: buildSeasonMetaItems(season),
    blocks,
  }
}
