import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BindingStore, GroupStore, HistoryStore, SettingsStore } from '../src/storage'

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

test('GroupStore persists player remark after save and reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apexrankwatch-remark-'))
  const file = join(dir, 'groups.json')
  const store = new GroupStore(file, logger)

  store.setPlayer('123456', 'name:moneri@PC', {
    playerName: 'moneri',
    platform: 'PC',
    lookupId: 'moneri',
    useUid: false,
    rankScore: 9999,
    rankName: '大师',
    rankDiv: 1,
    lastChecked: 100,
    globalRankPercent: '0.10',
    selectedLegend: '恶灵',
    legendKillsPercent: '0.20',
    remark: '大佬',
  })
  await store.save()

  const reloaded = new GroupStore(file, logger)
  await reloaded.load()
  assert.equal(reloaded.getGroup('123456')?.players['name:moneri@PC']?.remark, '大佬')

  reloaded.getGroup('123456')!.players['name:moneri@PC'].remark = undefined
  await reloaded.save()

  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw['123456'].players['name:moneri@PC'].remark, undefined)
})

test('BindingStore persists bindings by group and user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apexrankwatch-bindings-'))
  const file = join(dir, 'bindings.json')
  const store = new BindingStore(file, logger)

  store.setBinding('100', 'user-a', {
    groupId: '100',
    userId: 'user-a',
    lookupId: 'moeneri',
    useUid: false,
    platform: 'PC',
    playerName: 'moeneri',
    uid: '123456',
    updatedAt: 10,
  })
  store.setBinding('100', 'user-b', {
    groupId: '100',
    userId: 'user-b',
    lookupId: 'uid-1',
    useUid: true,
    platform: 'PS4',
    playerName: 'other',
    uid: 'uid-1',
    updatedAt: 20,
  })
  store.setBinding('200', 'user-a', {
    groupId: '200',
    userId: 'user-a',
    lookupId: 'switch-player',
    useUid: false,
    platform: 'SWITCH',
    playerName: 'switch-player',
    uid: 'abc',
    updatedAt: 30,
  })
  await store.save()

  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw['100']['user-a'].lookupId, 'moeneri')
  assert.equal(raw['100']['user-b'].platform, 'PS4')
  assert.equal(raw['200']['user-a'].platform, 'SWITCH')

  const reloaded = new BindingStore(file, logger)
  await reloaded.load()
  assert.equal(reloaded.getBinding('100', 'user-a')?.playerName, 'moeneri')
  assert.equal(reloaded.getBinding('100', 'user-b')?.useUid, true)
  assert.equal(reloaded.getBinding('200', 'user-a')?.platform, 'SWITCH')
})

test('BindingStore removes per-group binding without affecting others', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apexrankwatch-bindings-remove-'))
  const file = join(dir, 'bindings.json')
  const store = new BindingStore(file, logger)

  store.setBinding('100', 'user-a', {
    groupId: '100',
    userId: 'user-a',
    lookupId: 'moeneri',
    useUid: false,
    platform: 'PC',
    playerName: 'moeneri',
    uid: '123456',
    updatedAt: 10,
  })
  store.setBinding('200', 'user-a', {
    groupId: '200',
    userId: 'user-a',
    lookupId: 'other',
    useUid: false,
    platform: 'PS4',
    playerName: 'other',
    uid: '654321',
    updatedAt: 20,
  })

  assert.equal(store.removeBinding('100', 'user-a'), true)
  assert.equal(store.getBinding('100', 'user-a'), undefined)
  assert.equal(store.getBinding('200', 'user-a')?.playerName, 'other')
  assert.equal(store.removeBinding('100', 'user-a'), false)
})

test('HistoryStore persists and prunes events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apexrankwatch-history-'))
  const file = join(dir, 'history.json')
  const store = new HistoryStore(file, logger)

  store.appendEvent('100', {
    groupId: '100',
    playerKey: 'name:alpha@PC',
    playerName: 'alpha',
    platform: 'PC',
    oldScore: 10000,
    newScore: 10050,
    delta: 50,
    observedAt: 100,
  })
  store.appendEvent('100', {
    groupId: '100',
    playerKey: 'name:beta@PS4',
    playerName: 'beta',
    platform: 'PS4',
    oldScore: 9000,
    newScore: 8900,
    delta: -100,
    observedAt: 200,
  })
  await store.save()

  const reloaded = new HistoryStore(file, logger)
  await reloaded.load()
  assert.equal(reloaded.getGroupEvents('100').length, 2)

  reloaded.pruneOlderThan(150)
  await reloaded.save()
  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw['100'].length, 1)
  assert.equal(raw['100'][0].playerKey, 'name:beta@PS4')
})
