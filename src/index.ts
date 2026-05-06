import { Context } from 'koishi'
import type { Config as PluginConfig } from './config'
import { ConfigSchema, resolveConfig } from './config'
import { ApexRankWatchRuntime } from './runtime'

export const name = 'apexrankwatch'
export const Config = ConfigSchema

export function apply(ctx: Context, config: PluginConfig) {
  new ApexRankWatchRuntime(ctx, resolveConfig(config))
}
