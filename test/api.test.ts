import assert from 'node:assert/strict'
import test from 'node:test'
import { ApexApiClient } from '../src/api'

const logger = {
  info() {},
  warn() {},
  error(message: string) {
    throw new Error(message)
  },
}

test('fetchPlayerStatsAuto falls back to next platform when player is not on PC', async () => {
  const client = new ApexApiClient({
    apiKey: 'test-key',
    timeoutMs: 5000,
    maxRetries: 0,
    debugLogging: false,
    logger,
    fetcher: async (url) => {
      const parsed = new URL(url)
      const platform = parsed.searchParams.get('platform')
      if (platform === 'PC') {
        return new Response(JSON.stringify({ Error: 'Player not found' }), { status: 404 })
      }
      return new Response(JSON.stringify({
        global: {
          name: 'moneri',
          uid: '123456',
          level: 300,
          rank: {
            rankScore: 9999,
            rankName: 'Master',
            rankDiv: 1,
            ALStopPercentGlobal: '0.10',
          },
        },
        realtime: {
          isOnline: 1,
          currentStateAsText: 'in Lobby',
          selectedLegend: 'Wraith',
        },
        legends: {
          selected: {
            data: [
              {
                name: 'BR Kills',
                value: 1234,
                rank: {
                  topPercent: 0.23,
                },
              },
            ],
          },
        },
      }), { status: 200 })
    },
  })

  const result = await client.fetchPlayerStatsAuto('moneri')
  assert.equal(result.platform, 'PS4')
  assert.equal(result.player.name, 'moneri')
  assert.equal(result.player.rankScore, 9999)
  assert.equal(result.player.rankName, '大师')
  assert.equal(result.player.selectedLegend, '恶灵')
  assert.equal(result.player.currentState, '在大厅')
})

test('fetchCurrentSeasonInfo parses home and detail pages', async () => {
  const homeHtml = `
  <script type="application/ld+json">
  {
    "@type": "ItemList",
    "itemListElement": [
      { "position": 1, "name": "Season 25 · Prodigy", "url": "https://apexseasons.online/season-25/" }
    ]
  }
  </script>
  <div>Timezone · Pacific Time</div>
  <div>Respawn deploys all major updates at 10 AM Pacific Time.</div>
  <script>window.__TEST__ = {"targetDate":[0,"2026-05-06T17:00:00Z"]}</script>
  `

  const detailHtml = `
  <script type="application/ld+json">
  {
    "@type": "Event",
    "startDate": "2026-02-11T18:00:00Z",
    "endDate": "2026-05-06T17:00:00Z"
  }
  </script>
  <div>Timezone: UTC</div>
  `

  const client = new ApexApiClient({
    apiKey: '',
    timeoutMs: 5000,
    maxRetries: 0,
    debugLogging: false,
    logger,
    fetcher: async (url) => {
      if (url === 'https://apexseasons.online/') return new Response(homeHtml, { status: 200 })
      if (url === 'https://apexseasons.online/season-25/') return new Response(detailHtml, { status: 200 })
      throw new Error(`unexpected url: ${url}`)
    },
  })

  const season = await client.fetchCurrentSeasonInfo()
  assert.equal(season.seasonNumber, 25)
  assert.equal(season.seasonName, 'Prodigy')
  assert.equal(season.source, 'apexseasons.online')
  assert.equal(season.startIso, '2026-02-11T18:00:00Z')
  assert.equal(season.endIso, '2026-05-06T17:00:00Z')
  assert.equal(season.timezone, 'UTC')
})

test('invalid api key surfaces as auth error instead of player not found', async () => {
  const client = new ApexApiClient({
    apiKey: 'bad-key',
    timeoutMs: 5000,
    maxRetries: 0,
    debugLogging: false,
    logger,
    fetcher: async () => new Response(JSON.stringify({ Error: 'Invalid API key' }), { status: 401 }),
  })

  await assert.rejects(
    () => client.fetchPlayerStatsAuto('moneri', 'PC', false),
    /Invalid API key/,
  )
})

test('invalid predator api key surfaces as auth error for text response', async () => {
  const client = new ApexApiClient({
    apiKey: 'bad-key',
    timeoutMs: 5000,
    maxRetries: 0,
    debugLogging: false,
    logger,
    fetcher: async () => new Response(`Error: API key doesn't exist !`, { status: 404 }),
  })

  await assert.rejects(
    () => client.fetchPredatorInfo(),
    /Invalid API key/,
  )
})
