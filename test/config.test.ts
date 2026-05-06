import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/config'

test('resolveConfig supports camelCase keys', () => {
  const config = resolveConfig({
    apiKey: 'abc',
    checkInterval: 5,
    dataDir: './custom',
    maxRetries: 7,
    timeout: 12000,
    minValidScore: 9,
    blacklist: 'foo,bar',
    debugLogging: true,
    queryBlocklist: 'baz',
    userBlacklist: '10001',
    ownerQq: '10002',
    whitelistEnabled: true,
    whitelistGroups: '123',
    allowPrivate: false,
  })

  assert.equal(config.apiKey, 'abc')
  assert.equal(config.checkInterval, 5)
  assert.equal(config.dataDir, './custom')
  assert.equal(config.maxRetries, 7)
  assert.equal(config.timeoutMs, 12000)
  assert.equal(config.minValidScore, 9)
  assert.equal(config.blacklist, 'foo,bar')
  assert.equal(config.debugLogging, true)
  assert.equal(config.queryBlocklist, 'baz')
  assert.equal(config.userBlacklist, '10001')
  assert.equal(config.ownerQq, '10002')
  assert.equal(config.whitelistEnabled, true)
  assert.equal(config.whitelistGroups, '123')
  assert.equal(config.allowPrivate, false)
})

test('resolveConfig supports snake_case aliases', () => {
  const config = resolveConfig({
    api_key: 'xyz',
    check_interval: 3,
    data_dir: './data2',
    max_retries: 2,
    timeout_ms: 15000,
    min_valid_score: 6,
    debug_logging: 'true' as any,
    query_blocklist: 'aaa',
    user_blacklist: 'bbb',
    owner_qq: 'ccc',
    whitelist_enabled: '1' as any,
    whitelist_groups: 'group-1',
    allow_private: '0' as any,
  })

  assert.equal(config.apiKey, 'xyz')
  assert.equal(config.checkInterval, 3)
  assert.equal(config.dataDir, './data2')
  assert.equal(config.maxRetries, 2)
  assert.equal(config.timeoutMs, 15000)
  assert.equal(config.minValidScore, 6)
  assert.equal(config.debugLogging, true)
  assert.equal(config.queryBlocklist, 'aaa')
  assert.equal(config.userBlacklist, 'bbb')
  assert.equal(config.ownerQq, 'ccc')
  assert.equal(config.whitelistEnabled, true)
  assert.equal(config.whitelistGroups, 'group-1')
  assert.equal(config.allowPrivate, false)
})
