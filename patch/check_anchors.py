#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-community-market 升级兼容回归：检查设置页注入所依赖的 DOM 锚点是否仍存在。

ZCode 每次大版本更新后运行：python patch/check_anchors.py
全部 PASS 时 patch/settings-nav.js 无需改动；有 FAIL 时按提示更新 settings-nav.js 并升版本。

原理：渲染端 bundle 内这些 testid 多为动态拼接（`settings-section-nav-${id}`），
所以不能只搜完整字符串——分别验证：
  1) 拼接常量 `settings-section-nav` 存在；
  2) 分节配置里仍有 id 为 `plugin` 的分节（agentCapabilities 组）；
  3) `data-settings-panel-frame` / `data-settings-content-frame` / `settings-page` 字面量存在。
"""
import json
import os
import re
import struct
import sys


def asar_candidates():
    out = []
    if os.environ.get("ZCODE_ASAR"):
        out.append(os.environ["ZCODE_ASAR"])
    for p in (r"D:\ZCode\resources\app.asar",
              os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "ZCode", "resources", "app.asar")
              if os.environ.get("LOCALAPPDATA") else None,
              r"C:\Program Files\ZCode\resources\app.asar"):
        if p:
            out.append(p)
    return out


def main():
    asar = next((p for p in asar_candidates() if os.path.isfile(p)), None)
    if not asar:
        print("FAIL 找不到 app.asar（可用环境变量 ZCODE_ASAR 指定）")
        return 1
    raw = open(asar, "rb").read()

    checks = [
        ("拼接常量 settings-section-nav", b"settings-section-nav", raw.count(b"settings-section-nav") >= 2),
        ("分节 id `plugin`（data-testid=settings-section-nav-plugin 的来源）", b"id:`plugin`", raw.count(b"id:`plugin`") >= 1),
        ("data-settings-panel-frame", b"data-settings-panel-frame", raw.count(b"data-settings-panel-frame") >= 1),
        ("data-settings-content-frame", b"data-settings-content-frame", raw.count(b"data-settings-content-frame") >= 1),
        ("settings-page", b"settings-page", raw.count(b"settings-page") >= 1),
    ]
    fails = 0
    print(f"asar: {asar}")
    for name, pat, ok in checks:
        print(("PASS " if ok else "FAIL ") + name, f"({raw.count(pat)} hit)")
        fails += 0 if ok else 1
    if fails:
        print(f"\n{fails} 项锚点缺失：请更新 patch/settings-nav.js 的选择器并升版本发布")
    else:
        print("\n锚点全部在位，settings-nav.js 无需改动")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
