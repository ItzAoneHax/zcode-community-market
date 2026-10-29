/* zcode plugins CLI 串行运行器。
 * 宿主的插件存储锁是进程内的，跨进程并发会写丢——所有 CLI 调用必须经本模块的串行队列。 */
"use strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function cliCandidates() {
  const list = [];
  if (process.env.ZCODE_CLI) list.push(process.env.ZCODE_CLI);
  const roots = ["D:\\ZCode", "C:\\ZCode"];
  const extra = [];
  if (process.env.LOCALAPPDATA) extra.push(path.join(process.env.LOCALAPPDATA, "Programs", "ZCode"));
  extra.push("C:\\Program Files\\ZCode");
  for (const r of [...roots, ...extra]) list.push(path.join(r, "resources", "glm", "zcode.cjs"));
  return list;
}

let cachedCli = null;
function findCli() {
  if (cachedCli) return cachedCli;
  for (const p of cliCandidates()) {
    try { if (fs.statSync(p).isFile()) { cachedCli = p; return p; } } catch { /* next */ }
  }
  throw new Error("zcode.cjs not found; set ZCODE_CLI env to its absolute path");
}

/* 串行队列：链式 promise，保证同一时刻只有一个 CLI 进程在跑 */
let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(fn, fn); // 前一个失败不影响后续
  queue = next.catch(() => {});
  return next;
}

function runRaw(args, timeoutMs = 300000) {
  return enqueue(
    () =>
      new Promise((resolve) => {
        const cli = findCli();
        // Electron 主进程里 execPath 是 ZCode.exe：必须带 ELECTRON_RUN_AS_NODE=1 才能当 node 跑 CLI
        const inElectron = !!process.versions.electron;
        const env = { ...process.env };
        if (inElectron) env.ELECTRON_RUN_AS_NODE = "1";
        else delete env.ELECTRON_RUN_AS_NODE;
        const p = spawn(process.execPath, [cli, "plugins", ...args], {
          windowsHide: true,
          env,
        });
        let out = "", err = "", done = false;
        const timer = setTimeout(() => {
          if (!done) { done = true; try { p.kill(); } catch {} resolve({ code: -1, stdout: out, stderr: err + "\n[timeout]" }); }
        }, timeoutMs);
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -2, stdout: out, stderr: String(e) }); } });
        p.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? 0, stdout: out, stderr: err }); } });
      })
  );
}

async function runJson(args, timeoutMs) {
  const r = await runRaw([...args, "--json"], timeoutMs);
  if (r.code !== 0) throw new Error(`zcode plugins ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`.slice(0, 500));
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`zcode plugins ${args.join(" ")}: non-JSON output: ${r.stdout.slice(0, 300)}`);
  }
}

async function runText(args, timeoutMs) {
  const r = await runRaw(args, timeoutMs);
  const text = (r.stdout + (r.stderr ? "\n" + r.stderr : "")).trim();
  if (r.code !== 0) throw new Error(`zcode plugins ${args.join(" ")} failed (${r.code}): ${text.slice(0, 500)}`);
  return text;
}

/* ---- 高层操作 ---- */
export const cli = {
  findCli,
  listInstalled: () => runJson(["list"]),
  listOverview: () => runJson(["list", "--available"]),
  marketplaceList: () => runJson(["marketplace", "list"]),
  marketplaceAdd: (source) => runText(["marketplace", "add", source]),
  marketplaceUpdate: (name) => runText(["marketplace", "update", ...(name ? [name] : [])], 600000),
  install: (ref) => runText(["install", ref], 600000),
  uninstall: (ref, { keepData = false } = {}) =>
    runText(["uninstall", ref, "--force", ...(keepData ? ["--keep-data"] : [])], 600000),
  update: (ref) => runText(["update", ref], 600000),
  enable: (ref) => runText(["enable", ref]),
  disable: (ref) => runText(["disable", ref]),
};
