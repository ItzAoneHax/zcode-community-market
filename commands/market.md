---
description: 打开社区插件市场面板（浏览/安装/更新/管理 ZCode 社区插件）
---

打开社区插件市场侧栏面板给用户看：调用 MCP 工具 `open_market`（community-market 服务）。

面板里用户可以自己完成：浏览与搜索社区插件、安装/更新/卸载/启停、编辑各插件的共享设置。你只需要确认面板已打开；后续操作由用户在面板中完成。

如果用户想让你代办：用 `search_plugins` 查找、`install_plugin` 安装、`list_installed` 查看；并提醒"插件的技能/命令从新会话开始生效"。

用户附加要求：$ARGUMENTS
