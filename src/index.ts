import { Context } from 'koishi'
import type { Config as PluginConfig } from './config'
import { ConfigSchema, resolveConfig } from './config'
import { ApexRankWatchRuntime } from './runtime'

export const name = 'apexrankwatch'
export const Config = ConfigSchema
export const usage = [
  '填写 Apex Legends API Key 后即可使用玩家查询、猎杀线和群监控功能。',
  '支持使用 /apex绑定 绑定默认账号，并通过 /apex查分 快速查询自己的绑定账号信息。',
  '支持按北京时间自然日 / 自然周统计当前群的 /apex日上分榜、/apex日掉分榜、/apex周上分榜、/apex周掉分榜。',
  '地图轮换、赛季信息、帮助卡片和监控列表会优先以图片输出；图片生成失败时会自动回退文字。',
  '常用命令：/apexrank yumola pc、/apex查分、/apex绑定 yumola pc、/apexrankwatch yumola pc、/apex日上分榜、/apex周掉分榜、/map、/apexseason current、/apexpredator pc。',
].join('\n\n')

export function apply(ctx: Context, config: PluginConfig) {
  new ApexRankWatchRuntime(ctx, resolveConfig(config))
}
