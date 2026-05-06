import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GroupStore, SettingsStore } from '../src/storage'

const logger = {
  info() {},
  warn() {},
  error(message: string) {
    throw new Error(message)
  },
}

test('GroupStore migrates old koishi and astrbot-like payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apexrankwatch-storage-'))
  const file = join(dir, 'groups.json')

  await writeFile(file, JSON.stringify({
    '123456': {
      group_id: '123456',
      players: {
        'name:moneri@pc': {
          player_name: 'moneri',
          platform: 'pc',
          lookup_id: 'moneri',
          use_uid: false,
          rank_score: 8888,
          rank_name: '大师',
          rank_div: 1,
          global_rank_percent: '0.12',
          selected_legend: '恶灵',
          legend_kills_percent: '0.33',
          last_checked: 1,
        },
      },
    },
  }, null, 2), 'utf8')

  const store = new GroupStore(file, logger)
  await store.load()
  const group = store.getGroup('123456')

  assert.ok(group)
  assert.equal(group?.groupId, '123456')
  assert.equal(group?.target?.channelId, '123456')
  assert.equal(group?.players['name:moneri@pc']?.playerName, 'moneri')
  assert.equal(group?.players['name:moneri@pc']?.platform, 'PC')
  assert.equal(group?.players['name:moneri@pc']?.legendKillsPercent, '0.33')
})

test('SettingsStore persists runtime blacklist and season keyword groups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apexrankwatch-settings-'))
  const file = join(dir, 'settings.json')
  const store = new SettingsStore(file, logger)

  await store.save({
    runtimeBlacklist: ['foo', 'bar', 'foo'],
    seasonKeywordDisabledGroups: ['100', '200', '100'],
  })

  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(raw.runtime_blacklist, ['bar', 'foo'])
  assert.deepEqual(raw.season_keyword_disabled_groups, ['100', '200'])

  const loaded = await store.load()
  assert.deepEqual(loaded.runtimeBlacklist, ['bar', 'foo'])
  assert.deepEqual(loaded.seasonKeywordDisabledGroups, ['100', '200'])
})
