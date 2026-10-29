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

const SERVER_INFO = { name: "community-market", version: "0.2.0" };

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

function pollRequests() {
  const { app, BrowserWindow } = require("electron");
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (!isHostPage(wc)) continue;
    wc.executeJavaScript(
      `(function(){ var q = window.__cmarketRequests; if (!q || !q.length) return null;
        return JSON.stringify(q.splice(0, 8)); })()`
    ).then((raw) => {
      if (!raw) return;
      let reqs;
      try { reqs = JSON.parse(raw); } catch (e) { return; }
      for (const req of reqs || []) handleRequest(wc, req);
    }, () => {});
  }
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
  // mtime 热重载：settings-nav.js 变化后新页面注入新版本
  let lastMtime = 0;
  setInterval(() => {
    try {
      const m = fs.statSync(path.join(RUNTIME, "settings-nav.js")).mtimeMs;
      if (m !== lastMtime) { lastMtime = m; navSrc = fs.readFileSync(path.join(RUNTIME, "settings-nav.js"), "utf8"); }
    } catch (e) { /* ignore */ }
    pollRequests();
  }, 1000);
  log("loader up at", RUNTIME);
} catch (e) {
  log("loader init failed (not in electron main?):", e.message);
}
