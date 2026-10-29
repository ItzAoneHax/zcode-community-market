# zcode-community-market

ZCode 社区插件市场：在侧栏面板里探索、安装、更新、启停、卸载社区插件；内置可供其他插件调用的**共享设置中心**。

## 功能

- **探索**：内置精选索引（GitHub topic `zcode-plugin` 筛选）+ 一键从 GitHub 刷新合并
- **安装**：自动走 `marketplace add` → `plugins install`（仓库自带市场的直接装；不带的先尝试按市场添加，失败则给出仓库链接手动安装）
- **管理**：已装插件列表、版本对比更新、启用/禁用（新会话生效）、卸载
- **设置中心**：见下方契约

## 使用

- 对话框输入 `/market` 或直接说"打开社区插件市场"，模型调用 `open_market` 打开侧栏面板。
- Agent 侧工具：`search_plugins`、`install_plugin`、`list_installed`。

## 共享设置中心契约（其他插件接入）

你的插件（Agent/MCP 侧）调用 community-market 的 MCP 工具：

1. **注册**：`settings_register(pluginId, schema)` —
   ```json
   {
     "pluginId": "my-plugin@my-marketplace",
     "schema": {
       "title": "我的插件设置",
       "properties": {
         "apiKey":  { "type": "string", "title": "API Key", "default": "" },
         "limit":   { "type": "number", "title": "上限", "default": 10 },
         "lang":    { "type": "string", "title": "语言", "enum": ["zh", "en"], "default": "zh" }
       }
     }
   }
   ```
2. **读取**：`settings_get(pluginId)` → `{ schema, values }`（默认值已合并）
3. 用户在市场面板「设置中心」标签页里以表单修改并保存；`settings_set` 也接受程序写入（按 schema 校验）。

存储位置：`~/.zcode/cli/plugins/data/zcode-community-market@zcode-community-market/settings/<pluginId>.json`（原子写）。

## 二期（规划）

「社区插件市场」标签注入 ZCode 设置页侧栏（app.asar 补丁 + SessionStart 自愈），点击唤起同一面板。

## 安装/开发

本地市场安装（开发态）：

```
zcode plugins marketplace add C:\Users\limin\.zcode\plugins\zcode-community-market
zcode plugins install zcode-community-market@zcode-community-market
```

改代码后重装同版本：`zcode plugins update zcode-community-market@zcode-community-market`（或先 uninstall 再 install）。
