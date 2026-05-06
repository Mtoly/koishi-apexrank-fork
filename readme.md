# koishi-plugin-apexrankwatch

`koishi-plugin-apexrankwatch` 是一个面向 Koishi 的 Apex Legends 查询与监测插件。

它支持查询玩家段位、分数、等级、在线状态、赛季结束时间、大师/猎杀人数与猎杀底分，也支持在群聊中持续自动监测玩家分数变化并推送通知。

## 功能特点

- 查询玩家当前段位、RP、等级、在线状态、当前英雄与 UID
- 支持 `uid:` / `uuid:` 前缀查询
- 支持平台自动回退：`PC -> PS4 -> X1 -> SWITCH`
- 支持查询当前赛季结束时间
- 支持查询大师/猎杀人数与猎杀底分
- 支持群聊持续监测玩家分数变化并自动通知
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
- `/apexrankwatch <玩家名|uid:...> [平台]`
- `/apexranklist`
- `/apexrankremove <玩家名|uid:...> [平台]`
- `/apexpredator`
- `/apexseason`
- `/apexblacklist <add|remove|list|clear> <玩家ID>`
- `/赛季关闭`
- `/赛季开启`

## 命令别名

- `apex帮助`
- `apexrankhelp`
- `apex查询`
- `查询`
- `apex监控`
- `持续查询`
- `apex列表`
- `apex移除`
- `取消持续查询`
- `apex猎杀`
- `apex赛季`
- `新赛季`
- `apex测试`
- `apex黑名单`
- `不准查询`
- `apexban`

## 使用示例

查询玩家：

```text
/apexrank moeneri
/apexrank moeneri pc
/apexrank uid:1010153800824
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

移除监控：

```text
/apexrankremove moeneri
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
- 如果同名玩家存在多平台监控，移除时建议显式指定平台
- 赛季信息来自公开站点 `apexseasons.online`
- 玩家查询、监控与猎杀线依赖 `api.mozambiquehe.re`
- 如果没有配置可用 API Key，插件仍可加载，但在线查询类功能不可用

## 数据目录

默认数据目录为：

```text
./data/apexrankwatch
```

主要文件包括：

- `groups.json`：群监控数据
- `settings.json`：动态黑名单与赛季关键词开关

## 许可证

MIT
