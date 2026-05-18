import { buildQqAvatarUrl, formatPlatform } from '../shared'
import type { LeaderboardEntry } from '../shared'
import type { LeaderboardHtmlRow } from './resource-types'

function truncateText(value: string, maxLength = 18) {
  const text = String(value || '').trim()
  if (!text) return '未知玩家'
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function resolveBarPercent(deltaAbs: number, maxDeltaAbs: number) {
  if (!Number.isFinite(deltaAbs) || deltaAbs <= 0 || !Number.isFinite(maxDeltaAbs) || maxDeltaAbs <= 0) {
    return 0
  }
  const raw = (deltaAbs / maxDeltaAbs) * 100
  return clamp(raw, 10, 100)
}

export function normalizeLeaderboardHtmlRows(
  entries: LeaderboardEntry[],
  directionLabel: string,
  maxRows = 10,
): LeaderboardHtmlRow[] {
  const selectedEntries = entries.slice(0, maxRows)
  const maxDeltaAbs = selectedEntries.reduce((max, entry) => Math.max(max, Math.abs(entry.netDelta || 0)), 0)

  return selectedEntries.map((entry, index) => {
    const deltaAbs = Math.abs(entry.netDelta || 0)
    const barPercent = resolveBarPercent(deltaAbs, maxDeltaAbs)

    return {
      rank: index + 1,
      avatarCacheKey: entry.playerKey,
      avatarUrl: buildQqAvatarUrl(entry.ownerUserId || ''),
      displayName: entry.displayName,
      displayNameTruncated: truncateText(entry.displayName, 18),
      platformLabel: formatPlatform(entry.platform),
      latestScoreLabel: `${entry.latestScore}`,
      deltaLabel: directionLabel === '上分' ? `+${entry.netDelta}` : `-${Math.abs(entry.netDelta)}`,
      deltaDirection: directionLabel === '上分' ? 'gain' : 'loss',
      deltaAbs,
      barPercent,
      barWidthCss: `${barPercent.toFixed(2)}%`,
    }
  })
}
