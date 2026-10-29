#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-community-market 设置页注入补丁器。

向 ZCode 的 app.asar 主进程入口 (out/main/index.js) 末尾追加一行动态 import，
加载本插件的 cmarket-loader.cjs（主进程 loader），进而把「社区插件市场」导航项
注入设置页。asar 重打包算法（pickle 头 + 分块 SHA256 integrity + 对齐）适配自
ByteRax/zcode-token-usage-statusbar (MIT) 的已验证实现，独立精简重写。

与其他 asar 补丁插件（zusage 等）的共存约束：
- loader 文件名固定 cmarket-loader.cjs，日志标记固定 [community-market]；
- 剥离正则只匹配同时含这两者的行，绝不动别人的注入行；
- 暂存文件 .cmarket.tmp / 锁 .cmarket.lock 均为自有命名；
- 安装始终重读当前 asar（不依赖备份），替换失败留待收尾。

用法：
  python patch_install.py status
  python patch_install.py install
  python patch_install.py remove
  python patch_install.py --monitor        # 收尾：等 ZCode 退出后替换
"""
import json
import os
import re
import struct
import subprocess
import sys
import time
from pathlib import Path

ENTRY = "out/main/index.js"
BLOCK = 4 * 1024 * 1024
ALIGN = 4
RUNTIME = Path.home() / ".zcode" / "zcode-community-market"
LOADER = RUNTIME / "cmarket-loader.cjs"
MARK = "[community-market]"
INJECT_LINE_TMPL = (
    '\n;import("{url}").then(() => null, (e) => console.error("{mark} load failed", e));\n'
)
# 只剥离自己的行：必须同时含 loader 文件名与本插件标记
OWN_LINE_RE = re.compile(r'^.*cmarket-loader\.cjs.*\[community-market\].*$\n?', re.M)

TMP_SUFFIX = ".cmarket.tmp"
LOCK_NAME = "patch.cmarket.lock"
MONITOR_TIMEOUT_S = 6 * 60 * 60


def asar_candidates():
    out = []
    if os.environ.get("ZCODE_ASAR"):
        out.append(Path(os.environ["ZCODE_ASAR"]))
    if os.environ.get("ZCODE_WINDOWS_APP_INSTALL_DIR"):
        out.append(Path(os.environ["ZCODE_WINDOWS_APP_INSTALL_DIR"]) / "resources" / "app.asar")
    out.append(Path("D:/ZCode/resources/app.asar"))
    if os.environ.get("LOCALAPPDATA"):
        out.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "ZCode" / "resources" / "app.asar")
    out.append(Path("C:/Program Files/ZCode/resources/app.asar"))
    return out


def find_asar():
    for p in asar_candidates():
        try:
            if p.is_file():
                return p
        except OSError:
            continue
    raise SystemExit("未找到 ZCode 的 app.asar；可用环境变量 ZCODE_ASAR 指定路径")


def zcode_exe_of(asar_path: Path):
    # asar 位于 <install>/resources/app.asar → exe 在 <install>/ZCode.exe
    try:
        exe = asar_path.parent.parent / "ZCode.exe"
        return exe if exe.is_file() else None
    except OSError:
        return None


# ---------------- asar 读写（适配自 zusage MIT 实现） ----------------

def read_header(f):
    f.seek(0)
    a, b, c, d = struct.unpack("<4I", f.read(16))
    assert a == 4, f"unexpected pickle prefix {a}"
    header = json.loads(f.read(d))
    return header, 8 + b


def iter_files(node, path=""):
    for name, ch in node.get("files", {}).items():
        p = f"{path}/{name}"
        if "files" in ch:
            yield from iter_files(ch, p)
        else:
            yield p, ch


def compute_integrity(data: bytes):
    return {
        "algorithm": "SHA256",
        "hash": __import__("hashlib").sha256(data).hexdigest(),
        "blockSize": BLOCK,
        "blocks": [
            __import__("hashlib").sha256(data[i : i + BLOCK]).hexdigest()
            for i in range(0, len(data), BLOCK)
        ],
    }


def entry_bytes_of(asar_path: Path) -> bytes:
    with open(asar_path, "rb") as f:
        header, base = read_header(f)
        nodes = dict(iter_files(header))
        node = nodes["/" + ENTRY]
        f.seek(base + int(node["offset"]))
        return f.read(node["size"])


def repack(src_path: Path, modify: dict, dst_path: Path):
    import hashlib

    with open(src_path, "rb") as src:
        header, base = read_header(src)
        header = json.loads(json.dumps(header))
        nodes = dict(iter_files(header))
        missing = set(modify) - set(nodes)
        assert not missing, f"paths not in asar: {missing}"

        data_parts = []
        offset = 0
        for p, node in nodes.items():
            if node.get("unpacked"):
                node["offset"] = "0"
                continue
            if p in modify:
                data = modify[p]
                node["size"] = len(data)
                node["integrity"] = {
                    "algorithm": "SHA256",
                    "hash": hashlib.sha256(data).hexdigest(),
                    "blockSize": BLOCK,
                    "blocks": [
                        hashlib.sha256(data[i : i + BLOCK]).hexdigest()
                        for i in range(0, len(data), BLOCK)
                    ],
                }
            else:
                src.seek(base + int(node["offset"]))
                data = src.read(node["size"])
            node["offset"] = str(offset)
            data_parts.append(data)
            offset += len(data)

        payload = b"".join(data_parts)
        header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        d = len(header_bytes)
        c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
        b_total = c + 4
        with open(dst_path, "wb") as out:
            out.write(struct.pack("<4I", 4, b_total, c, d))
            out.write(header_bytes)
            out.write(b"\0" * (c - d - 4))
            assert out.tell() == 8 + b_total, "header pad mismatch"
            out.write(payload)
    return dst_path


# ---------------- 裥丁流程 ----------------

class PatchLock:
    """自有锁文件；超过 10 分钟视为陈旧可抢占。"""

    def __init__(self, asar_path: Path):
        self.path = asar_path.parent / LOCK_NAME

    def __enter__(self):
        for _ in range(50):
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    age = time.time() - self.path.stat().st_mtime
                    if age > 600:
                        self.path.unlink(missing_ok=True)
                        continue
                except OSError:
                    pass
                time.sleep(0.2)
        raise SystemExit("补丁锁被占用（另一进程正在操作），请稍后重试")

    def __exit__(self, *a):
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass


def syntax_check(asar_path: Path, entry: bytes) -> bool:
    exe = zcode_exe_of(asar_path)
    if not exe:
        print("  [check] 未找到 ZCode.exe，跳过语法检查（警告）")
        return True
    tmp = Path(os.environ.get("TEMP", ".")) / "cmarket-entry-check.mjs"
    tmp.write_bytes(entry)
    try:
        env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
        r = subprocess.run(
            [str(exe), "--check", str(tmp)], capture_output=True, timeout=60, env=env
        )
        ok = r.returncode == 0
        print(f"  [check] 语法检查 exit={r.returncode}")
        if not ok:
            print(r.stderr.decode("utf-8", "replace")[:500])
        return ok
    except Exception as e:  # noqa: BLE001
        print(f"  [check] 语法检查异常（跳过）: {e}")
        return True
    finally:
        tmp.unlink(missing_ok=True)


def stage(asar_path: Path, want_injected: bool) -> Path:
    """准备暂存包：want_injected=True 加注入行，False 剥离。返回 tmp 路径。"""
    if not LOADER.is_file() and want_injected:
        raise SystemExit(f"loader 不存在: {LOADER}（先完成运行时同步）")
    entry = entry_bytes_of(asar_path)
    text = entry.decode("utf-8")
    stripped = OWN_LINE_RE.sub("", text)
    already = MARK in stripped and "cmarket-loader.cjs" in stripped
    if want_injected and already:
        print("已安装：注入行已存在，无需改动")
        return asar_path
    if not want_injected and not already:
        print("未安装：本来就没有注入行，无需改动")
        return asar_path
    new_text = stripped + (INJECT_LINE_TMPL.format(url=LOADER.as_uri(), mark=MARK) if want_injected else "")
    new_entry = new_text.encode("utf-8")
    tmp = asar_path.parent / ("app.asar" + TMP_SUFFIX)
    repack(asar_path, {"/" + ENTRY: new_entry}, tmp)
    # 结构自检
    with open(tmp, "rb") as f:
        header, _ = read_header(f)
        n_tmp = sum(1 for _ in iter_files(header))
    with open(asar_path, "rb") as f:
        header0, _ = read_header(f)
        n_src = sum(1 for _ in iter_files(header0))
    assert n_tmp == n_src, f"文件数变化 {n_src} -> {n_tmp}"
    staged = entry_bytes_of(tmp)
    assert (MARK in staged.decode("utf-8", "replace")) == want_injected, "暂存包注入状态不符"
    print(f"  [stage] 重打包完成（文件数={n_tmp}）")
    if want_injected and not syntax_check(asar_path, new_entry):
        tmp.unlink(missing_ok=True)
        raise SystemExit("语法检查失败，已放弃")
    return tmp


def spawn_monitor(asar_path: Path):
    me = Path(__file__).resolve()
    exe = sys.executable
    flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    subprocess.Popen(
        [exe, str(me), "--monitor", "--asar", str(asar_path)],
        creationflags=flags,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        close_fds=True,
    )


def replace_or_pending(asar_path: Path, tmp: Path) -> bool:
    if tmp == asar_path:
        return True
    try:
        os.replace(str(tmp), str(asar_path))
        print("已替换 app.asar（完全退出并重开 ZCode 后生效）")
        return True
    except PermissionError:
        print("ZCode 正在运行，暂存待收尾：已启动监控进程，完全退出 ZCode 后自动完成替换")
        spawn_monitor(asar_path)
        return False


def do_install(asar_path: Path):
    with PatchLock(asar_path):
        tmp = stage(asar_path, True)
        ok = replace_or_pending(asar_path, tmp)
        # 记录“曾安装”标记（自愈钩子依据）；清除卸载豁免
        RUNTIME.mkdir(parents=True, exist_ok=True)
        (RUNTIME / "patched.once").write_text("1\n", encoding="utf-8")
        (RUNTIME / "optout").unlink(missing_ok=True)
        if not ok:
            print("提醒：完全退出 ZCode 后监控进程自动完成替换，再重新打开生效")


def do_remove(asar_path: Path):
    with PatchLock(asar_path):
        tmp = stage(asar_path, False)
        replace_or_pending(asar_path, tmp)
        # 卸载豁免：阻止自愈钩子自动重注入
        RUNTIME.mkdir(parents=True, exist_ok=True)
        (RUNTIME / "optout").write_text("1\n", encoding="utf-8")


def do_monitor(asar_path: Path):
    """收尾：ZCode 退出后替换。替换前从“最佳候选源”重建暂存，
    保证同时携带其它补丁插件（如 zusage）已排定的注入行，避免先换者抹掉后换者。"""
    tmp = asar_path.parent / ("app.asar" + TMP_SUFFIX)
    deadline = time.time() + MONITOR_TIMEOUT_S
    rebuilt = False
    while time.time() < deadline:
        if not tmp.exists() and rebuilt:
            return  # 已被其它进程收尾或清理
        if not rebuilt:
            try:
                with PatchLock(asar_path):
                    _rebuild_merged_tmp(asar_path, tmp)
                rebuilt = True
            except Exception as e:  # noqa: BLE001
                print(f"[monitor] 重建暂存失败（按原样继续）: {e}")
                rebuilt = True
        try:
            os.replace(str(tmp), str(asar_path))
            print("[monitor] 替换完成")
            return
        except PermissionError:
            time.sleep(3)
        except OSError:
            return
    print("[monitor] 超时放弃（暂存文件保留，会话钩子将自动重排）")


FOREIGN_MARKERS = {
    # 其它补丁插件的注入行特征：行内同时含 loader 名与日志标记（与本插件的剥离正则同构）
    "zusage": ("inject-main.cjs", "[zusage]"),
}


def _entry_text_of(path: Path):
    try:
        return entry_bytes_of(path).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return ""


def _rebuild_merged_tmp(asar_path: Path, tmp: Path):
    """从含最多外来注入行的候选源重建暂存（当前 asar / 兄弟暂存包）。"""
    candidates = [asar_path]
    for name in os.listdir(asar_path.parent):
        if name.endswith(".tmp") and name != tmp.name and "app.asar" in name:
            candidates.append(asar_path.parent / name)
    own_re = OWN_LINE_RE

    def foreign_count(text):
        return sum(1 for a, b in FOREIGN_MARKERS.values() if a in text and b in text)

    best, best_n, best_text = asar_path, -1, None
    for cand in candidates:
        text = _entry_text_of(cand)
        if not text:
            continue
        if "cmarket-loader.cjs" in text and MARK in text:
            continue  # 已含本插件行的候选没有意义（避免旧循环叠加）
        n = foreign_count(text)
        if n > best_n:
            best, best_n, best_text = cand, n, text
    if best_text is None:
        best_text = _entry_text_of(asar_path)
    stripped = own_re.sub("", best_text)
    if MARK in stripped:
        print("[monitor] 当前已含本插件注入行，无需替换")
        tmp.unlink(missing_ok=True)
        return
    new_entry = (stripped + INJECT_LINE_TMPL.format(url=LOADER.as_uri(), mark=MARK)).encode("utf-8")
    repack(best, {"/" + ENTRY: new_entry}, tmp)
    print(f"[monitor] 已从 {best.name} 重建合并暂存（外来注入行组数={best_n}）")


def do_status(asar_path: Path):
    tmp = asar_path.parent / ("app.asar" + TMP_SUFFIX)
    try:
        text = entry_bytes_of(asar_path).decode("utf-8", "replace")
        injected = "cmarket-loader.cjs" in text and MARK in text
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"asar": str(asar_path), "error": str(e)}, ensure_ascii=False))
        return
    print(json.dumps({
        "asar": str(asar_path),
        "injected": injected,
        "pendingTmp": tmp.exists(),
        "loaderReady": LOADER.is_file(),
        "runtime": str(RUNTIME),
    }, ensure_ascii=False))


def main():
    opts = sys.argv[1:]
    if "--monitor" in opts:
        cmd = "monitor"
        args = []
    else:
        args = [a for a in opts if not a.startswith("--")]
        cmd = args[0] if args else "status"
    asar = None
    if "--asar" in opts:
        asar = Path(opts[opts.index("--asar") + 1])
    asar = asar or find_asar()
    if not asar.is_file():
        raise SystemExit(f"app.asar 不存在: {asar}")
    if cmd == "install":
        do_install(asar)
    elif cmd == "remove":
        do_remove(asar)
    elif cmd == "status":
        do_status(asar)
    elif cmd == "monitor":
        do_monitor(asar)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
