import assert from 'node:assert/strict'
import { buildLeaderboard, getLeaderboardWindow } from '../src/leaderboard'
import { ScoreChangeEvent, StoredPlayerRecord } from '../src/shared'
import test from 'node:test'

test('getLeaderboardWindow returns current beijing day window', () => {
  const now = new Date('2026-05-10T04:00:00.000Z')
  const window = getLeaderboardWindow('day', now)
  assert.equal(window.startAt, Date.parse('2026-05-09T16:00:00.000Z'))
  assert.equal(window.endAt, now.getTime())
})

test('getLeaderboardWindow returns current beijing week window starting monday', () => {
  const now = new Date('2026-05-10T04:00:00.000Z')
  const window = getLeaderboardWindow('week', now)
  assert.equal(window.startAt, Date.parse('2026-05-03T16:00:00.000Z'))
  assert.equal(window.endAt, now.getTime())
})

test('buildLeaderboard aggregates by net delta and filters current players', () => {
  const players: Record<string, StoredPlayerRecord> = {
    'name:alpha@PC': {
      playerName: 'alpha',
      platform: 'PC',
      lookupId: 'alpha',
      useUid: false,
      rankScore: 10100,
      rankName: '大师',
      rankDiv: 1,
      lastChecked: 1,
      globalRankPercent: '0.10',
      selectedLegend: '恶灵',
      legendKillsPercent: '0.20',
      remark: '大佬A',
    },
    'name:beta@PS4': {
      playerName: 'beta',
      platform: 'PS4',
      lookupId: 'beta',
      useUid: false,
      rankScore: 9800,
      rankName: '钻石',
      rankDiv: 2,
      lastChecked: 1,
      globalRankPercent: '0.30',
      selectedLegend: '希尔',
      legendKillsPercent: '0.40',
    },
  }

  const events: ScoreChangeEvent[] = [
    {
      groupId: '100',
      playerKey: 'name:alpha@PC',
      playerName: 'alpha',
      platform: 'PC',
      oldScore: 10000,
      newScore: 10050,
      delta: 50,
      observedAt: Date.parse('2026-05-10T02:00:00.000Z'),
    },
    {
      groupId: '100',
      playerKey: 'name:alpha@PC',
      playerName: 'alpha',
      platform: 'PC',
      oldScore: 10050,
      newScore: 10100,
      delta: 50,
      observedAt: Date.parse('2026-05-10T03:00:00.000Z'),
    },
    {
      groupId: '100',
      playerKey: 'name:beta@PS4',
      playerName: 'beta',
      platform: 'PS4',
      oldScore: 9900,
      newScore: 9800,
      delta: -100,
      observedAt: Date.parse('2026-05-10T03:30:00.000Z'),
    },
    {
      groupId: '100',
      playerKey: 'name:removed@PC',
      playerName: 'removed',
      platform: 'PC',
      oldScore: 9000,
      newScore: 9050,
      delta: 50,
      observedAt: Date.parse('2026-05-10T03:30:00.000Z'),
    },
  ]

  const up = buildLeaderboard(events, players, 'up', 'day', new Date('2026-05-10T04:00:00.000Z'))
  assert.equal(up.length, 1)
  assert.equal(up[0].playerKey, 'name:alpha@PC')
  assert.equal(up[0].netDelta, 100)
  assert.equal(up[0].changeCount, 2)
  assert.equal(up[0].currentScore, 10100)

  const down = buildLeaderboard(events, players, 'down', 'day', new Date('2026-05-10T04:00:00.000Z'))
  assert.equal(down.length, 1)
  assert.equal(down[0].playerKey, 'name:beta@PS4')
  assert.equal(down[0].netDelta, -100)
})

test('buildLeaderboard excludes zero net delta entries', () => {
  const players: Record<string, StoredPlayerRecord> = {
    'name:alpha@PC': {
      playerName: 'alpha',
      platform: 'PC',
      lookupId: 'alpha',
      useUid: false,
      rankScore: 10000,
      rankName: '大师',
      rankDiv: 1,
      lastChecked: 1,
      globalRankPercent: '0.10',
      selectedLegend: '恶灵',
      legendKillsPercent: '0.20',
    },
  }

  const events: ScoreChangeEvent[] = [
    {
      groupId: '100',
      playerKey: 'name:alpha@PC',
      playerName: 'alpha',
      platform: 'PC',
      oldScore: 10000,
      newScore: 10050,
      delta: 50,
      observedAt: Date.parse('2026-05-10T02:00:00.000Z'),
    },
    {
      groupId: '100',
      playerKey: 'name:alpha@PC',
      playerName: 'alpha',
      platform: 'PC',
      oldScore: 10050,
      newScore: 10000,
      delta: -50,
      observedAt: Date.parse('2026-05-10T03:00:00.000Z'),
    },
  ]

  assert.deepEqual(buildLeaderboard(events, players, 'up', 'day', new Date('2026-05-10T04:00:00.000Z')), [])
  assert.deepEqual(buildLeaderboard(events, players, 'down', 'day', new Date('2026-05-10T04:00:00.000Z')), [])
})
