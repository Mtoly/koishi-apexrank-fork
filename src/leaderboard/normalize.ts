import { buildQqAvatarUrl, formatPlatform } from '../shared'
import type { LeaderboardEntry } from '../shared'
import type { LeaderboardHtmlRow } from './resource-types'

function truncateText(value: string, maxLength = 18) {
  const text = String(value || '').trim()
  if (!text) return '未知玩家'
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`
}

export function normalizeLeaderboardHtmlRows(
  entries: LeaderboardEntry[],
  directionLabel: string,
  maxRows = 10,
): LeaderboardHtmlRow[] {
  return entries.slice(0, maxRows).map((entry, index) => ({
    rank: index + 1,
    avatarCacheKey: entry.playerKey,
    avatarUrl: buildQqAvatarUrl(entry.ownerUserId || ''),
    displayName: entry.displayName,
    displayNameTruncated: truncateText(entry.displayName, 18),
    platformLabel: formatPlatform(entry.platform),
    latestScoreLabel: `${entry.latestScore}`,
    deltaLabel: directionLabel === '上分' ? `+${entry.netDelta}` : `-${Math.abs(entry.netDelta)}`,
    deltaDirection: directionLabel === '上分' ? 'gain' : 'loss',
  }))
}
