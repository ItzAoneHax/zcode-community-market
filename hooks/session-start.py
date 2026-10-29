#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart 钩子：同步运行时目录 + 设置页补丁自愈。

流程：
1. sync_runtime：把插件目录的 loader/导航/面板/核心模块拷到 ~/.zcode/zcode-community-market/
   （稳定路径，插件升级换缓存目录不影响 asar 注入行）。
2. ensure_patch：读当前 app.asar 判断注入状态；未注入且未豁免（豁免文件
   ~/.zcode/zcode-community-market/optout 或环境变量 ZCODE_CMARKET_NO_PATCH=1）
   且曾经注入过（runtime/patched.once 标记，避免默认强改用户客户端）→ 自动重补。
   从未注入过不自动装（用户经面板/命令显式安装）。
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
RUNTIME = Path.home() / ".zcode" / "zcode-community-market"
PATCHER = PLUGIN_ROOT / "patch" / "patch_install.py"

SYNC_FILES = [
    ("patch/cmarket-loader.cjs", "cmarket-loader.cjs"),
    ("patch/settings-nav.js", "settings-nav.js"),
    ("dist/ui/panel.html", "panel.html"),
    # server 模块放 server/ 子目录：core.mjs 按两层父目录定位插件根，
    # 平铺布局会错指到 ~/.zcode/（已在 0.2.1 踩坑），必须保持与插件一致的目录层级
    ("server/core.mjs", "server/core.mjs"),
    ("server/cli.mjs", "server/cli.mjs"),
    ("server/catalog.mjs", "server/catalog.mjs"),
    ("server/settings.mjs", "server/settings.mjs"),
    ("data/community-index.json", "data/community-index.json"),
]


def sync_runtime():
    changed = []
    for src_rel, dst_rel in SYNC_FILES:
        src = PLUGIN_ROOT / src_rel
        dst = RUNTIME / dst_rel
        if not src.is_file():
            continue
        if dst.is_file() and src.read_bytes() == dst.read_bytes():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(dst.suffix + ".tmp")
        shutil.copyfile(src, tmp)
        os.replace(tmp, dst)
        changed.append(dst_rel)
    return changed


def ensure_patch():
    if os.environ.get("ZCODE_CMARKET_NO_PATCH") == "1":
        return "optout(env)"
    if (RUNTIME / "optout").exists():
        return "optout(file)"
    once = RUNTIME / "patched.once"
    if not once.exists():
        return "never-installed"
    r = subprocess.run(
        [sys.executable, str(PATCHER), "status"], capture_output=True, text=True, timeout=60
    )
    if '"injected": true' in r.stdout:
        return "ok"
    r2 = subprocess.run(
        [sys.executable, str(PATCHER), "install"], capture_output=True, text=True, timeout=600
    )
    return "re-patched: " + (r2.stdout or r2.stderr).strip().splitlines()[-1][:120]


def main():
    try:
        changed = sync_runtime()
        state = ensure_patch()
        print(f"[community-market] runtime sync: {len(changed)} changed; patch: {state}")
    except Exception as e:  # noqa: BLE001
        print(f"[community-market] hook error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
