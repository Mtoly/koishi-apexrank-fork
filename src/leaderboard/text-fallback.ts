import type { LeaderboardRenderRequest } from './types'
import { formatPlatform } from '../shared'

export function formatLeaderboardText(request: LeaderboardRenderRequest) {
  const { title, periodRangeText, entries, directionLabel } = request
  const lines = [title, periodRangeText]
  if (!entries.length) {
    lines.push('ℹ️ 当前统计周期内暂无符合条件的分数变化记录。')
    return lines.join('\n')
  }

  entries.slice(0, 10).forEach((entry, index) => {
    const deltaText = directionLabel === '上分' ? `+${entry.netDelta}` : `-${Math.abs(entry.netDelta)}`
    lines.push(`${index + 1}. ${entry.displayName}`)
    lines.push(`   平台：${formatPlatform(entry.platform)} ｜ 变动：${deltaText} ｜ 当前分：${entry.latestScore}`)
  })
  return lines.join('\n')
}
