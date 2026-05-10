import { LeaderboardDirection, LeaderboardEntry, LeaderboardPeriod, ScoreChangeEvent, StoredPlayerRecord } from './shared'

function getBeijingDateParts(date: Date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  })
  const parts = formatter.formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'),
  }
}

function beijingMidnightUtc(date: Date) {
  const { year, month, day } = getBeijingDateParts(date)
  return Date.UTC(year, month - 1, day, -8, 0, 0, 0)
}

function beijingWeekdayIndex(weekday: string) {
  return {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  }[weekday] ?? 0
}

export function getLeaderboardWindow(period: LeaderboardPeriod, now = new Date()) {
  const endAt = now.getTime()
  const dayStart = beijingMidnightUtc(now)
  if (period === 'day') {
    return { startAt: dayStart, endAt }
  }
  const weekdayIndex = beijingWeekdayIndex(getBeijingDateParts(now).weekday)
  return {
    startAt: dayStart - weekdayIndex * 86_400_000,
    endAt,
  }
}

export function buildLeaderboard(
  events: ScoreChangeEvent[],
  players: Record<string, StoredPlayerRecord>,
  direction: LeaderboardDirection,
  period: LeaderboardPeriod,
  now = new Date(),
): LeaderboardEntry[] {
  const { startAt, endAt } = getLeaderboardWindow(period, now)
  const aggregates = new Map<string, LeaderboardEntry>()

  for (const event of events) {
    if (event.observedAt < startAt || event.observedAt > endAt) continue
    const player = players[event.playerKey]
    if (!player) continue

    const current = aggregates.get(event.playerKey) ?? {
      playerKey: event.playerKey,
      playerName: player.playerName,
      platform: player.platform,
      netDelta: 0,
      changeCount: 0,
      currentScore: player.rankScore,
    }
    current.netDelta += event.delta
    current.changeCount += 1
    current.currentScore = player.rankScore
    current.playerName = player.playerName
    current.platform = player.platform
    aggregates.set(event.playerKey, current)
  }

  const result = Array.from(aggregates.values()).filter((entry) => direction === 'up' ? entry.netDelta > 0 : entry.netDelta < 0)
  result.sort((a, b) => {
    if (direction === 'up') {
      if (b.netDelta !== a.netDelta) return b.netDelta - a.netDelta
    } else {
      if (a.netDelta !== b.netDelta) return a.netDelta - b.netDelta
    }
    const absDiff = Math.abs(b.netDelta) - Math.abs(a.netDelta)
    if (absDiff !== 0) return absDiff
    if (b.changeCount !== a.changeCount) return b.changeCount - a.changeCount
    return a.playerName.localeCompare(b.playerName, 'zh-CN')
  })
  return result
}
