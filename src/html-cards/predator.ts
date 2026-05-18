import { formatPlatform } from '../shared'
import type { PredatorInfo, PredatorPlatformInfo } from '../shared'
import type {
  HtmlCardDocument,
  HtmlCardKeyValueBlock,
  HtmlCardMetaItem,
  HtmlCardTableBlock,
} from './types'

const UNKNOWN_TEXT = '未知'
const REFERENCE_NOTE = '第三方猎杀线与大师数量数据仅供参考，请以游戏内实际显示为准。'
const BEIJING_TIMEZONE = 'Asia/Shanghai'

function hasDisplayText(value: string | null | undefined): value is string {
  const text = String(value || '').trim()
  return !!text && text !== UNKNOWN_TEXT
}

function normalizeDisplayText(value: string | null | undefined) {
  return hasDisplayText(value) ? value.trim() : UNKNOWN_TEXT
}

function formatPredatorMode(mode: string) {
  return mode === 'RP' ? '排位积分 (RP)' : normalizeDisplayText(mode)
}

function formatPredatorPlatformLabel(platform: string) {
  const formatted = formatPlatform(platform)
  return normalizeDisplayText(formatted || platform)
}

function formatPredatorNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return UNKNOWN_TEXT
  return Math.trunc(value).toLocaleString('en-US')
}

function formatPredatorUpdateTime(platforms: PredatorPlatformInfo[]) {
  const timestamp = platforms.find((entry) => entry.updateTimestamp !== null && entry.updateTimestamp !== undefined)?.updateTimestamp
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return UNKNOWN_TEXT

  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return UNKNOWN_TEXT

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

function resolveDisplayedPlatforms(predator: PredatorInfo, selectedPlatform = '') {
  return selectedPlatform
    ? predator.platforms.filter((entry) => entry.platform === selectedPlatform)
    : predator.platforms
}

function formatDisplayedPlatformSummary(platforms: PredatorPlatformInfo[], selectedPlatform = '') {
  if (selectedPlatform) return formatPredatorPlatformLabel(selectedPlatform)

  const labels = Array.from(new Set(platforms.map((entry) => formatPredatorPlatformLabel(entry.platform)).filter(Boolean)))
  return labels.length ? labels.join(' / ') : UNKNOWN_TEXT
}

function buildPredatorMetaItems(
  predator: PredatorInfo,
  displayedPlatforms: PredatorPlatformInfo[],
  selectedPlatform = '',
): HtmlCardMetaItem[] {
  return [
    { label: '模式', value: formatPredatorMode(predator.mode) },
    { label: '更新时间', value: formatPredatorUpdateTime(displayedPlatforms) },
    { label: '平台', value: formatDisplayedPlatformSummary(displayedPlatforms, selectedPlatform) },
  ]
}

function buildPredatorSinglePlatformBlock(platform: PredatorPlatformInfo): HtmlCardKeyValueBlock {
  return {
    type: 'key-value',
    title: formatPredatorPlatformLabel(platform.platform),
    rows: [
      {
        label: '猎杀线 (RP)',
        value: formatPredatorNumber(platform.requiredRp),
      },
      {
        label: '大师数量（包含猎杀）',
        value: formatPredatorNumber(platform.mastersCount),
      },
    ],
  }
}

function buildPredatorMultiPlatformBlock(platforms: PredatorPlatformInfo[]): HtmlCardTableBlock {
  return {
    type: 'table',
    title: '平台数据',
    columns: ['平台', '猎杀线 (RP)', '大师数量（包含猎杀）'],
    rows: platforms.map((platform) => [
      formatPredatorPlatformLabel(platform.platform),
      formatPredatorNumber(platform.requiredRp),
      formatPredatorNumber(platform.mastersCount),
    ]),
  }
}

function buildPredatorDataBlocks(platforms: PredatorPlatformInfo[]): HtmlCardDocument['blocks'] {
  if (!platforms.length) return []
  if (platforms.length === 1) return [buildPredatorSinglePlatformBlock(platforms[0])]
  return [buildPredatorMultiPlatformBlock(platforms)]
}

export function buildPredatorCardDocument(predator: PredatorInfo, selectedPlatform = ''): HtmlCardDocument {
  const displayedPlatforms = resolveDisplayedPlatforms(predator, selectedPlatform)
  const blocks: HtmlCardDocument['blocks'] = [
    ...buildPredatorDataBlocks(displayedPlatforms),
    {
      type: 'tip',
      title: '说明',
      content: REFERENCE_NOTE,
      variant: 'warn',
    },
  ]

  return {
    title: 'Apex 猎杀线与大师数量',
    metaItems: buildPredatorMetaItems(predator, displayedPlatforms, selectedPlatform),
    blocks,
  }
}
