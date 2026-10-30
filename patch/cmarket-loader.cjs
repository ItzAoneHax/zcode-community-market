/* zcode-community-market 主进程 loader（由 app.asar 入口注入行加载）。
 * 职责：① 向宿主 file:// 渲染页注入 settings-nav.js；② 轮询渲染端
 * window.__cmarketRequests（{id, method, params, __src}），经 core.mjs 分发，
 * 以 window.__cmarketResult({jsonrpc, id, result|error, __src}) 回执。
 * 与 zusage 等其它注入插件互不干扰：命名均带 cmarket 前缀。 */
"use strict";
const path = require("path");
const fs = require("fs");

const RUNTIME = __dirname; // ~/.zcode/zcode-community-market
const TAG = "[community-market]";
const log = (...a) => { try { console.error(TAG, ...a); } catch (e) {} };

let navSrc = null;
try { navSrc = fs.readFileSync(path.join(RUNTIME, "settings-nav.js"), "utf8"); }
catch (e) { log("settings-nav.js missing:", e.message); }

let core = null; // 动态 import 的 core.mjs（含全部工具与 CLI 队列）；文件变化时用 cache-buster 热重载
async function loadCore() {
  try {
    const { pathToFileURL } = require("url");
    const mtimes = ["core.mjs", "cli.mjs", "catalog.mjs", "settings.mjs"]
      .map((f) => { try { return fs.statSync(path.join(RUNTIME, "server", f)).mtimeMs; } catch (e) { return 0; } })
      .join("-");
    const url = pathToFileURL(path.join(RUNTIME, "server", "core.mjs")).href + "?t=" + mtimes;
    core = await import(url);
    log("core loaded (" + mtimes + ")");
  } catch (e) { log("core load failed:", e.message); }
}
loadCore();
setInterval(() => { loadCore(); }, 5000); // mtime 变化 → 新 URL → 全新模块图

const SERVER_INFO = { name: "community-market", version: "0.4.1" };

async function dispatch(method, params) {
  if (method === "initialize")
    return { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: SERVER_INFO };
  if (method === "ping") return {};
  if (method === "tools/call") {
    const t = (core?.ALL_TOOLS || []).find((x) => x.name === params?.name);
    if (!t) throw new Error(`Unknown tool: ${params?.name}`);
    const r = await t.handler(params.arguments ?? {});
    return { content: [{ type: "text", text: String(r.text ?? "") }], ...(r.structured ? { structuredContent: r.structured } : {}) };
  }
  throw new Error(`Method not found: ${method}`);
}

function isHostPage(wc) {
  try {
    const u = wc.getURL();
    return u.startsWith("file://") && u.includes("/app.asar/") && !u.includes("panel.html");
  } catch (e) { return false; }
}

function injectInto(wc) {
  if (!navSrc || !isHostPage(wc)) return;
  let panelUrl = "null";
  try { panelUrl = JSON.stringify(require("url").pathToFileURL(path.join(RUNTIME, "panel.html")).href); } catch (e) {}
  wc.executeJavaScript(
    `(function(){ if (window.__cmarketNavLoaded) return; window.__cmarketNavLoaded = true;\n` +
    `window.__CMARKET_PANEL_URL = ${panelUrl};\n` +
    navSrc +
    `\n})();`
  ).then(() => {}, (e) => log("inject failed:", e.message));
}

/* 轮询自适应：空闲 1s 一拍；发现请求后 8s 内提速到 200ms 一拍。
 * 面板串行 RPC（如设置中心逐项拉取）旧版每请求固定吃 1s 轮询延迟。 */
let pollFastUntil = 0;
let pollBusy = false;
function pollRequests() {
  const { app, BrowserWindow } = require("electron");
  const jobs = [];
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (!isHostPage(wc)) continue;
    jobs.push(wc.executeJavaScript(
      `(function(){ var q = window.__cmarketRequests; if (!q || !q.length) return null;
        return JSON.stringify(q.splice(0, 16)); })()`
    ).then((raw) => {
      if (!raw) return false;
      let reqs;
      try { reqs = JSON.parse(raw); } catch (e) { return false; }
      for (const req of reqs || []) handleRequest(wc, req);
      return true;
    }, () => false));
  }
  return Promise.all(jobs).then((rs) => rs.some(Boolean));
}

function schedulePoll() {
  const delay = Date.now() < pollFastUntil ? 200 : 1000;
  setTimeout(async () => {
    if (pollBusy) return schedulePoll(); // 上一拍 executeJavaScript 未归，跳过本拍避免堆积
    pollBusy = true;
    let had = false;
    try { had = await pollRequests(); } catch (e) { /* ignore */ }
    pollBusy = false;
    if (had) pollFastUntil = Date.now() + 8000;
    schedulePoll();
  }, delay);
}

function handleRequest(wc, req) {
  const src = req.__src || "nav";
  dispatch(req.method, req.params)
    .then((result) => reply(wc, { jsonrpc: "2.0", id: req.id, result, __src: src }))
    .catch((e) => reply(wc, { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: e?.message ?? String(e) }, __src: src }));
}

function reply(wc, obj) {
  wc.executeJavaScript(`window.__cmarketResult && window.__cmarketResult(${JSON.stringify(JSON.stringify(obj))})`, true)
    .then(() => {}, () => {});
}

try {
  const { app, BrowserWindow } = require("electron");
  app.on("web-contents-created", (_e, wc) => {
    wc.on("dom-ready", () => injectInto(wc));
    wc.on("did-finish-load", () => injectInto(wc));
  });
  // mtime 热重载：settings-nav.js 变化后新页面注入新版本（5s 一查，与轮询解耦）
  let lastMtime = 0;
  setInterval(() => {
    try {
      const m = fs.statSync(path.join(RUNTIME, "settings-nav.js")).mtimeMs;
      if (m !== lastMtime) { lastMtime = m; navSrc = fs.readFileSync(path.join(RUNTIME, "settings-nav.js"), "utf8"); }
    } catch (e) { /* ignore */ }
  }, 5000);
  schedulePoll();
  log("loader up at", RUNTIME);
} catch (e) {
  log("loader init failed (not in electron main?):", e.message);
}
