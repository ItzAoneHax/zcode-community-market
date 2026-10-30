# zcode-community-market · 社区插件市场

[![Version](https://img.shields.io/badge/version-0.3.2-blue)]() [![License](https://img.shields.io/badge/license-MIT-green)]() [![ZCode](https://img.shields.io/badge/for-ZCode%20Desktop-purple)]()

ZCode 桌面客户端的**社区插件市场**：在侧栏面板里浏览、搜索、安装、更新、启停、卸载社区插件；内置可供其他插件调用的**共享设置中心**；并提供可选的 **ZCode 设置页入口注入**（在设置页左栏「插件」下方加一项「社区插件市场」）。

![探索页截图](docs/screenshot-explore.png)
*（截图占位：探索页）*

---

## 目录

- [功能特性](#功能特性)
- [安装方法](#安装方法)
- [使用方法](#使用方法)
- [插件共享设置中心（开发者向）](#插件共享设置中心开发者向)
- [常见问题](#常见问题-faq)
- [免责声明](#免责声明)
- [English](#english)

---

## 功能特性

市场面板包含四个标签页：

### 🧭 探索

- 内置精选索引（GitHub topic [`zcode-plugin`](https://github.com/topics/zcode-plugin) 人工筛选）+ 一键「从 GitHub 刷新」合并最新仓库
- 关键词搜索（名称 / 描述 / 仓库）、按分类筛选（监控、外观、效率、开发、编排等）
- 「↻ 可更新」过滤：只看已安装且有新版本的插件
- 显示星标数、分类、安装状态；一键安装：自动走 `marketplace add` → `plugins install`（仓库自带市场的直接装；不带的先尝试按市场添加，失败则给出仓库链接提示手动安装）

![已安装页截图](docs/screenshot-installed.png)
*（截图占位：已安装页）*

### 📦 已安装

- 已装插件列表：版本、启停开关（新会话生效）、卸载
- 版本对比更新：市场上有新版本时显示「可更新」徽标，一键更新
- 更新日志：点「日志」查看插件仓库的版本变更（GitHub Releases，无 Releases 时回退 README 的更新日志段落）

### ⚙️ 设置中心

- 所有接入共享设置中心的插件在此以表单方式集中编辑、保存
- 契约见下方[插件共享设置中心](#插件共享设置中心开发者向)

![设置中心截图](docs/screenshot-hub.png)
*（截图占位：设置中心）*

### ℹ️ 关于

- 插件版本、索引更新时间、收录/已装插件数
- 「设置页入口」注入 / 卸载（见[使用方法](#设置页入口可选)）
- 已添加的插件市场源列表

### 🤖 模型侧工具（对话里直接让 AI 代办）

安装本插件后，AI 会多出以下 MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `open_market` | 打开市场侧栏面板（`/market` 命令背后就是它） |
| `search_plugins` | 搜索社区插件目录 |
| `install_plugin` | 按 `owner/name` 仓库或 `name@marketplace` 引用安装 |
| `list_installed` | 列出已装插件及启停状态 |
| `settings_register` / `settings_get` / `settings_set` / `settings_list` | 共享设置中心读写 |
| `patch_install` / `patch_remove` / `patch_status` | 设置页入口注入管理 |

---

## 安装方法

### 方式一：从 GitHub 市场（推荐）

在 ZCode 对话框输入（`/plugin` 命令）：

```
/plugin marketplace add ItzAoneHax/zcode-community-market
/plugin install zcode-community-market@zcode-community-market
```

或使用 CLI（任意终端）：

```bash
zcode plugins marketplace add ItzAoneHax/zcode-community-market
zcode plugins install zcode-community-market@zcode-community-market
```

> 市场名与插件名相同，都是 `zcode-community-market`，所以安装引用是 `zcode-community-market@zcode-community-market`（有点绕，但没错）。

### 方式二：本地开发

```bash
git clone https://github.com/ItzAoneHax/zcode-community-market.git
cd zcode-community-market
zcode plugins marketplace add .          # 或写克隆出来的绝对路径
zcode plugins install zcode-community-market@zcode-community-market
```

改代码后重装同版本：

```bash
zcode plugins update zcode-community-market@zcode-community-market
# 或先 uninstall 再 install
```

---

## 使用方法

### 打开面板

- 对话框输入 `/market`
- 或直接说「打开社区插件市场」

AI 会调用 `open_market` 在侧栏打开面板，之后浏览、安装、更新、启停、卸载、改设置都在面板里点按完成。

> 插件的能力（技能 / 命令 / MCP 工具）在**新会话**开始生效；安装完提示「新会话生效」是正常的。

### 设置页入口（可选）

不想用侧栏面板的话，可以把「社区插件市场」注入 ZCode 设置页左栏（「插件」分节下方）：

1. 打开市场面板 → **关于** 标签页 → 点「**注入设置页入口**」
2. **完全退出 ZCode（所有窗口）**，重新打开——从 ZCode 菜单选择「退出」，只关窗口 / 刷新页面无效
3. 设置页左栏「插件」下方会出现「🛒 社区插件市场」，点击即在右侧内容区打开同一面板（Esc 关闭）

说明：

- 该操作会修改客户端 `app.asar`（详见[免责声明](#免责声明)），与 zcode-token-usage-statusbar（zusage）等其它 asar 补丁插件互不干扰
- ZCode 升级覆盖 `app.asar` 后，会话启动钩子会**自动重补**注入
- 不想要了：**关于** 标签页点「卸载设置页入口」，同样完全退出重开生效

---

## 插件共享设置中心（开发者向）

你的插件可以通过 MCP 调用本插件的工具，把设置表单注册进「设置中心」，用户在面板里统一编辑，你的插件下次读取即得新值。

**1. 注册**：`settings_register(pluginId, schema)`

```json
{
  "pluginId": "my-plugin@my-marketplace",
  "schema": {
    "title": "我的插件设置",
    "description": "可选的表单说明",
    "properties": {
      "apiKey": { "type": "string",  "title": "API Key", "default": "" },
      "limit":  { "type": "number",  "title": "上限",     "default": 10 },
      "lang":   { "type": "string",  "title": "语言", "enum": ["zh", "en"], "default": "zh" },
      "dark":   { "type": "boolean", "title": "深色模式", "default": false }
    }
  }
}
```

**2. 读取**：`settings_get(pluginId)` → `{ schema, values }`（默认值已合并）

**3. 写入**：`settings_set(pluginId, values)`（按 schema 校验；用户在面板保存也走同一路径）

存储位置（原子写，pluginId 仅允许 `[A-Za-z0-9_.@-]`）：

```
~/.zcode/cli/plugins/data/zcode-community-market@zcode-community-market/settings/<pluginId>.json
```

---

## 常见问题 FAQ

**面板打不开怎么办？**

1. 开个**新会话**再试 `/market`（插件刚装完，当前会话还没加载它的工具）
2. 还不行就**完全退出 ZCode 重开**（`zcode plugins list` 里确认插件已启用）
3. 依旧不行：`zcode plugins list` 看插件是否在列，缺依赖（Node.js ≥ 18）先补齐

**怎么卸载本插件？**

先在「关于」页卸载设置页入口（如果注入过），再：

```
/plugin uninstall zcode-community-market@zcode-community-market
```

**会和 zusage 等其它改 app.asar 的插件冲突吗？**

不会。每个补丁插件的注入行、loader 文件名、锁文件、暂存包命名都是独立的；本插件剥离注入行时只匹配自己的标记，收尾替换时还会从含最多注入行的候选重建暂存包，避免先换者抹掉后换者。

**GitHub 刷新报限速（403/429）？**

匿名 GitHub API 有速率限制；在市场面板「关于」标签页填写 **GitHub Token**（personal access token，无需勾选任何 scope，仅存本机），或设置环境变量 `GITHUB_TOKEN`。面板配置优先于环境变量。更新日志拉取同样受益。

**装过的插件旧版本会残留吗？**

不会。卸载插件时会对照已装清单（`installed_plugins.json`）清理 `cache/<市场>/<插件>/` 下的旧版本残留目录，只清未被引用的目录。

---

## 免责声明

「设置页入口」为**可选功能**，启用即表示你知晓并同意：该操作会修改 ZCode 客户端的 `app.asar` 文件（在主进程入口末尾追加一行动态 `import`）。尽管已做语法检查、结构自检、原子替换与多插件兼容，修改客户端文件仍有风险（如与未来版本不兼容），**请自担风险**；不启用该功能则完全不触碰客户端文件。因使用本插件造成的任何损失，作者不承担责任。

---

## 更新日志

- **v0.3.2**（2026-10-30）：**重要修复**——缓存清理误读已装清单结构（条目嵌套于顶层 `plugins` 键），导致「更新后清理」会把刚装好的新版本一并删除；现严格按清单 `installPath` 保护在用目录，且更新后仅在清单已指向新版本时才执行清理。
- **v0.3.1**（2026-10-30）：社区索引全量刷新（59 个插件，新增 44 个并逐个核实安装策略；6 个 `marketplace-try` 经实测升级为 `marketplace`，speed-panel 降级为手动安装）；更新插件后同样清理旧版本缓存；安装时不再覆盖同 id 的既有市场源（保护本地开发市场）；新增 `patch/check_anchors.py` 升级兼容自检脚本。
- **v0.3.0**（2026-10-30）：探索页「↻ 可更新」过滤；已安装页更新日志（GitHub Releases / README 变更段）；卸载自动清理 `cache/` 旧版本残留；GitHub Token 面板内配置（「关于」页，设置中心存储，token 类字段自动遮蔽）；面板骨架屏与加载失败重试按钮。
- **v0.2.1**（2026-10-29）：首个公开版本。市场面板（探索 / 已安装 / 设置中心 / 关于）、共享设置中心、设置页入口注入 + 会话钩子自愈。

---

# English

**zcode-community-market** — a community plugin marketplace for the ZCode desktop client. Browse, search, install, update, enable/disable and uninstall community plugins from a sidebar panel; ships a **shared settings hub** other plugins can call, and an **optional settings-page entry injection**.

## Features

- **Explore** — curated index (GitHub topic `zcode-plugin`) + one-click refresh from GitHub; keyword search, category filters, an "updatable" filter, stars, one-click install (`marketplace add` → `plugins install`)
- **Installed** — list with versions, enable/disable toggles (effective next session), uninstall, version-compare updates, release notes (GitHub Releases, falling back to the README changelog section)
- **Settings Hub** — central form UI for settings registered by any plugin
- **About** — version info, settings-page entry injection management, marketplace sources
- **Model-side tools** — `open_market`, `search_plugins`, `install_plugin`, `list_installed`, `settings_*`, `patch_*`

## Install

From the GitHub marketplace (in ZCode):

```
/plugin marketplace add ItzAoneHax/zcode-community-market
/plugin install zcode-community-market@zcode-community-market
```

Or via CLI: `zcode plugins marketplace add ItzAoneHax/zcode-community-market && zcode plugins install zcode-community-market@zcode-community-market`

Local development: clone the repo, then `zcode plugins marketplace add <path>` + `zcode plugins install zcode-community-market@zcode-community-market`.

## Usage

- Type `/market` or ask to "open the community market" — the panel opens in the sidebar.
- Optional settings-page entry: About tab → "Inject settings-page entry", then **fully quit and reopen ZCode**. Re-injected automatically after ZCode upgrades by the session hook.
- Settings hub contract (for plugin devs): call `settings_register(pluginId, schema)` with a JSON-schema subset (`string` / `number` / `boolean` / `enum` properties with `title`, `description`, `default`), read via `settings_get(pluginId)`, write via `settings_set(pluginId, values)`.

## Disclaimer

The settings-page entry is an **optional** feature that modifies the ZCode client's `app.asar` (appends one dynamic-import line to the main entry). Syntax checks, structural self-checks, atomic replacement and multi-patch coexistence are implemented, but modifying client files is still at your own risk. All other features never touch client files.

## Changelog

- **v0.3.2** (2026-10-30): **critical fix** — cache cleanup misread the installed-manifest structure (entries nested under a top-level `plugins` key), so post-update cleanup could delete the freshly installed version; in-use dirs are now strictly protected by manifest `installPath`, and post-update cleanup only runs once the manifest points at the new version.
- **v0.3.1** (2026-10-30): full community index refresh (59 plugins, 44 additions with per-repo install-strategy verification; 6 `marketplace-try` entries live-verified and upgraded to `marketplace`; speed-panel demoted to manual); cache cleanup also runs after updates; installs no longer overwrite an existing marketplace source with the same id; added `patch/check_anchors.py` for upgrade-compatibility self-checks.
- **v0.3.0** (2026-10-30): "updatable" filter in Explore; release notes in Installed; uninstall now cleans stale version dirs under `cache/`; GitHub Token configurable in the panel (About tab, stored in the settings hub, token-like fields masked); skeleton loading state with a retry button.
- **v0.2.1** (2026-10-29): initial public release.
