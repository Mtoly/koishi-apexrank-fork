# koishi-plugin-apexrankwatch

`koishi-plugin-apexrankwatch` 是一个面向 Koishi 的 Apex Legends 查询与监测插件。

它支持查询玩家段位、分数、等级、在线状态、赛季结束时间、大师/猎杀人数与猎杀底分，也支持在群聊中持续自动监测玩家分数变化并推送通知。

## 功能特点

- 查询玩家当前段位、RP、等级、在线状态、当前英雄与 UID
- 支持 `uid:` / `uuid:` 前缀查询
- 支持平台自动回退：`PC -> PS4 -> X1 -> SWITCH`
- 支持群内绑定 Apex 账号，并通过 `apex查分` 快捷查询绑定账号
- 支持给监控玩家设置备注名，并在监控列表、通知与榜单中统一展示
- 支持查询当前赛季结束时间
- 支持查询大师/猎杀人数与猎杀底分
- 支持群聊持续监测玩家分数变化并自动通知
- 支持每日/每周上分榜与掉分榜
- 兼容旧版 Koishi 插件的原有使用习惯与历史数据目录
- 对异常掉分与 API 异常做了保护，避免错误数据直接覆盖原始记录

## 安装

```bash
yarn add koishi-plugin-apexrankwatch
```

安装后在 Koishi 中启用插件，并填写可用的 Apex API Key 即可。

## 常用命令

- `/apextest`
- `/apexhelp`
- `/apexrank <玩家名|uid:...> [平台]`
- `/apexbind <玩家名|uid:...> [平台]`
- `/apexunbind`
- `/apexscore`
- `/apexrankwatch <玩家名|uid:...> [平台]`
- `/apexranklist`
- `/apexremark <玩家名|uid:...> [备注]`
- `/apexrankremove <玩家名|uid:...> [平台]`
- `/apexdayup`
- `/apexdaydown`
- `/apexweekup`
- `/apexweekdown`
- `/apexpredator`
- `/apexseason`
- `/apexblacklist <add|remove|list|clear> <玩家ID>`
- `/赛季关闭`
- `/赛季开启`

## 命令别名

- `apex帮助`
- `apexrankhelp`
- `apex查询`
- `视奸`
- `apex绑定`
- `apex解绑`
- `apex查分`
- `apex监控`
- `持续视奸`
- `apex列表`
- `apex备注`
- `apex移除`
- `取消持续视奸`
- `apex日上分榜`
- `apex日掉分榜`
- `apex周上分榜`
- `apex周掉分榜`
- `apex猎杀`
- `apex赛季`
- `新赛季`
- `apex测试`
- `apex黑名单`
- `不准视奸`
- `apexban`

## 使用示例

查询玩家：

```text
/apexrank moeneri
/apexrank moeneri pc
/apexrank uid:1010153800824
```

绑定并查询自己的账号：

```text
/apexbind moeneri
/apexscore
/apexunbind
```

绑定 UID：

```text
/apexbind uid:1010153800824
```

添加群监控：

```text
/apexrankwatch moeneri
/apexrankwatch moeneri ps4
```

查看监控列表：

```text
/apexranklist
```

设置或清除备注：

```text
/apexremark moeneri 大佬
/apexremark moeneri pc 车队主C
/apexremark moeneri
```

移除监控：

```text
/apexrankremove moeneri
```

查看日榜 / 周榜：

```text
/apexdayup
/apexdaydown
/apexweekup
/apexweekdown
```

查询赛季信息：

```text
/apexseason
/新赛季
```

查询猎杀线：

```text
/apexpredator
```

## 使用说明

- 未指定平台时，插件会自动尝试多个平台
- 群内绑定作用域为“群 ID + 用户 ID”，不同群可以绑定不同账号
- `/apexscore` / `apex查分` 用于查询当前群内当前用户绑定的账号
- 如果同名玩家存在多平台监控，移除或备注时建议显式指定平台
- 榜单仅统计当前群、当前仍在监控中的玩家
- 榜单仅统计监控轮询中真实观测到的有效分数变化
- 赛季重置型大幅掉分不会计入榜单，但仍会更新当前状态并发送通知
- 赛季信息来自公开站点 `apexseasons.online`
- 玩家查询、监控与猎杀线依赖 `api.mozambiquehe.re`
- 如果没有配置可用 API Key，插件仍可加载，但在线查询类功能不可用

## 数据目录

默认数据目录为：

```text
./data/apexrankwatch
```

主要文件包括：

- `groups.json`：群监控数据与玩家备注
- `settings.json`：动态黑名单与赛季关键词开关
- `bindings.json`：群内用户绑定的 Apex 账号数据
- `history.json`：监控轮询产生的分数变化历史，用于日榜 / 周榜统计

## 许可证

MIT
