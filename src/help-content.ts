export interface HelpContentOptions {
  checkInterval?: number
  minValidScore?: number
  configBlacklistCount?: number
  runtimeBlacklistCount?: number
  queryBlocklistCount?: number
}

export interface HelpContentSection {
  title: string
  rows: Array<[string, string]>
}

export function getHelpParameterRows(options: HelpContentOptions = {}): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['平台', 'PC / PS4 / X1 / SWITCH；PC 无数据会自动尝试其他平台'],
    ['UID', '使用 uid: 或 uuid: 前缀，例如 /apexrank uid:000000'],
    ['监控间隔', `${options.checkInterval ?? 2} 分钟`],
    ['最小有效分', `${options.minValidScore ?? 1} 分`],
    ['异常分数', '仅当高分掉到接近 0 分时判定为异常'],
    ['权限', '支持群白名单、用户黑名单、主人账号、私聊开关'],
  ]
  const totalBlacklist = (options.configBlacklistCount ?? 0) + (options.runtimeBlacklistCount ?? 0)
  if (totalBlacklist) rows.push(['黑名单', `配置 ${options.configBlacklistCount ?? 0} 个，动态 ${options.runtimeBlacklistCount ?? 0} 个`])
  if (options.queryBlocklistCount) rows.push(['禁止查询', `已设置 ${options.queryBlocklistCount} 个玩家ID`])
  return rows
}

export function getHelpContentSections(options: HelpContentOptions = {}): HelpContentSection[] {
  return [
    {
      title: '查询',
      rows: [
        ['/apexrank 玩家 [平台]', '查询玩家段位、分数、在线状态'],
        ['/apex查询 /视奸', '中文别名，默认 PC，支持 uid:'],
        ['/apex查分 [玩家|uid:...]', '无参数查询绑定账号，也可临时指定目标'],
        ['/apex绑定 /apex解绑 /apex我的账号', '绑定默认 Apex 账号并查看绑定信息'],
      ],
    },
    {
      title: '监控',
      rows: [
        ['/apexrankwatch 玩家 [平台]', '添加群内持续监控'],
        ['/apexranklist /apex列表', '查看本群监控列表'],
        ['/apexremark 玩家 [平台] [备注] /apex备注', '设置或清除监控备注'],
        ['/apexrankremove 玩家 [平台] /取消持续视奸', '移除指定玩家监控'],
        ['/apex日上分榜 /apex日掉分榜', '查看当前群北京时间自然日榜单'],
        ['/apex周上分榜 /apex周掉分榜', '查看当前群北京时间自然周榜单'],
        ['/apex监控 /持续视奸', '添加监控中文别名'],
      ],
    },
    {
      title: '信息',
      rows: [
        ['/map /地图 /排位地图', '排位地图轮换，默认输出图片'],
        ['/匹配地图', '三人赛地图轮换'],
        ['/apexpredator [平台] /apex猎杀 /猎杀', '大师数量与猎杀底分'],
        ['/apexseason [赛季号|current] /新赛季', '当前或历史赛季时间'],
        ['赛季关键词', '群消息包含赛季时自动回复'],
      ],
    },
    {
      title: '管理',
      rows: [
        ['/apexblacklist add 玩家ID', '加入动态黑名单'],
        ['/apexblacklist list', '查看配置与动态黑名单'],
        ['/赛季关闭 /赛季开启', '管理本群赛季关键词回复'],
      ],
    },
    {
      title: '参数',
      rows: getHelpParameterRows(options),
    },
  ]
}
