/* zcode-community-market 核心逻辑（纯模块，无 stdio 副作用）。
 * server.mjs（MCP 协议层）与 patch/cmarket-loader.cjs（主进程注入）共用。 */
"use strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cli } from "./cli.mjs";
import { loadBundledIndex, fetchGithub, refreshCache, mergedCatalog, dataDir } from "./catalog.mjs";
import { settings } from "./settings.mjs";

export const PLUGIN_VERSION = "0.4.1";
const SELF_ID = "zcode-community-market@zcode-community-market";
export const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const bundledIndex = loadBundledIndex(PLUGIN_ROOT);

/* ---------- 本插件自身设置（共享设置中心）：GitHub Token ---------- */
let selfSettingsReady = false;
function ensureSelfSettings() {
  if (selfSettingsReady) return;
  selfSettingsReady = true;
  try {
    settings.register(SELF_ID, {
      title: "社区插件市场",
      description: "本插件自身设置（GitHub Token 仅存本机，用于目录刷新与更新日志拉取）",
      properties: {
        githubToken: { type: "string", title: "GitHub Token", description: "可选。匿名 GitHub API 限速（403/429）时填写，避免刷新/日志拉取失败", default: "" },
      },
    });
  } catch { /* 注册失败则仅用环境变量 */ }
}
/* 取 GitHub Token：设置中心优先，环境变量 GITHUB_TOKEN 兜底 */
export function githubToken() {
  ensureSelfSettings();
  try { return settings.get(SELF_ID).values?.githubToken || process.env.GITHUB_TOKEN || null; } catch { return process.env.GITHUB_TOKEN || null; }
}
ensureSelfSettings(); // 服务启动即注册自身 schema（幂等），面板「关于」页保存不依赖调用时序

/* ---------- 工具注册表 ---------- */
const TOOLS = [];
function tool(t) { TOOLS.push(t); }
export const log = (...a) => process.stderr.write(`[community-market] ${a.join(" ")}\n`);

/* ================= 业务逻辑 ================= */

function catalogWithState() {
  const cat = mergedCatalog(bundledIndex);
  return cat;
}

/* ---------- 面板状态缓存：get_state 串行跑 2 个 CLI（各约 2s）太慢，
 * 这里做 TTL + stale-while-revalidate：新开面板秒回；变更操作后失效重建。 ---------- */
const STATE_TTL_MS = 15000;
let stateCache = null; // { at, data }
let stateRefreshing = null; // 进行中的重建（去重并发触发）

function buildStateData() {
  // 单条 CLI（list --available）拿到 installed+available；marketplaces 已拆到 list_marketplaces
  return cli.listOverview().then((overview) => {
    const installed = overview?.installed || [];
    const available = overview?.available || [];
    const availById = new Map(available.map((a) => [a.id, a]));
    const cat = catalogWithState();
    const plugins = cat.plugins.map((p) => {
      const ip = installed.find((i) => i.name === p.name);
      const ap = ip ? availById.get(ip.id) : null;
      return {
        ...p,
        installedId: ip?.id || null,
        installedVersion: ip?.version ?? null,
        enabled: ip?.enabled ?? null,
        marketVersion: ap?.version ?? null,
        updateAvailable: !!(ip && ap?.version && ip?.version && ap.version !== ip.version),
      };
    });
    return {
      selfVersion: PLUGIN_VERSION,
      catalogUpdatedAt: cat.updatedAt,
      plugins,
      installed: installed.map((i) => ({
        id: i.id, name: i.name, version: i.version ?? null, marketplace: i.marketplace,
        enabled: i.enabled, description: availById.get(i.id)?.description ?? "",
      })),
    };
  });
}

function refreshState() {
  if (stateRefreshing) return stateRefreshing;
  stateRefreshing = buildStateData()
    .then((data) => { stateCache = { at: Date.now(), data }; })
    .catch(() => { /* 重建失败保留旧缓存 */ })
    .finally(() => { stateRefreshing = null; });
  return stateRefreshing;
}

/* 变更操作后调用：失效并后台重建（下一次 get_state 如未就绪仍会等待重建结果） */
function invalidateState() {
  stateCache = null;
  refreshState();
}

async function getStateData() {
  if (stateCache) {
    if (Date.now() - stateCache.at >= STATE_TTL_MS) refreshState(); // 过期：先回旧值，后台刷新
    return stateCache.data;
  }
  await refreshState();
  if (stateCache) return stateCache.data;
  throw new Error("state unavailable（CLI 调用失败，稍后重试）");
}

setTimeout(() => { refreshState(); }, 1200); // 启动预热：首个面板打开即命中缓存

async function installedMap() {
  const st = await getStateData();
  const map = new Map();
  for (const p of st.installed || []) map.set(p.id, p);
  return map;
}

/* 安装目录条目：按策略走 marketplace add → install */
async function installEntry(entry) {
  const inst = entry?.install || {};
  if (!inst.type) throw new Error("该插件没有可用的自动安装策略，请查看仓库说明手动安装");
  if (inst.type === "manual") {
    return {
      ok: false, manual: true, repo: entry.repo,
      url: `https://github.com/${entry.repo}`,
      message: "该插件需按仓库 README 手动安装（通常为 git clone 后运行 install 脚本）。",
    };
  }
  // marketplace / marketplace-try 共用：先加市场（已存在视为成功）
  let mktId = inst.marketplace || null;
  // 防覆盖：该 id 的市场已存在（含用户本地同名市场）时不再 add，避免把既有源换成远端仓库
  let existingSameId = null;
  try {
    const mkts0 = await cli.marketplaceList();
    const list0 = Array.isArray(mkts0) ? mkts0 : mkts0?.marketplaces || [];
    existingSameId = list0.find((x) => (x.name || x.id) === mktId) || null;
  } catch { /* 列表读不到就按原流程 add */ }
  if (existingSameId) {
    mktId = existingSameId.name || existingSameId.id;
  } else {
    try {
      const out = await cli.marketplaceAdd(inst.source);
      const m = /Added marketplace ([A-Za-z0-9_.@-]+)/.exec(out || "");
      if (m) mktId = m[1];
    } catch (e) {
      const s = String(e?.message || e);
      if (!/already|exists/i.test(s)) {
        if (inst.type === "marketplace") throw e;
        return { ok: false, manual: true, repo: entry.repo, url: `https://github.com/${entry.repo}`, message: `自动添加市场失败：${s.slice(0, 200)}` };
      }
      // 已存在：从市场列表反查 id
      try {
        const mkts = await cli.marketplaceList();
        const hit = (Array.isArray(mkts) ? mkts : mkts?.marketplaces || []).find(
          (x) => inst.source.startsWith(String(x?.source?.repo || x?.source?.url || "\u0000")) || x.name === inst.marketplace
        );
        if (hit) mktId = hit.name || hit.id;
      } catch { /* 用 hint */ }
    }
  }
  if (!mktId) mktId = inst.marketplace || inst.pluginName;
  // 在该市场里找插件（优先 pluginName，否则取该市场唯一可用项）
  const ov = await cli.listOverview();
  const cands = (ov?.available || []).filter((a) => a.marketplace === mktId && !a.installed);
  let target = cands.find((c) => c.name === inst.pluginName) || null;
  if (!target && cands.length === 1) target = cands[0];
  if (!target) {
    const already = (ov?.installed || []).find((i) => i.marketplace === mktId && i.name === inst.pluginName);
    if (already) return { ok: true, id: already.id, message: "已安装", alreadyInstalled: true };
    throw new Error(`在市场 ${mktId} 中未找到可安装的插件（期望 ${inst.pluginName || "任意"}）`);
  }
  const out = await cli.install(target.id);
  return { ok: true, id: target.id, message: out.split("\n").slice(-1)[0] || "installed" };
}

/* 已装清单条目：兼容 {"version","plugins":{...}} 嵌套与扁平两种结构 */
function installedEntriesOf(j) {
  const src = j && typeof j === "object" && j.plugins && typeof j.plugins === "object" ? j.plugins : j;
  return Object.values(src).filter((x) => x && typeof x === "object" && x.installPath);
}

/* 卸载后清残留：cache/<市场>/<插件>/ 下未被 installed_plugins.json 引用的版本目录。
 * 已装条目按 installPath 全路径比对（同插件换市场重装等场景不会误删在用目录）。 */
function pluginCacheCleanup(id) {
  try {
    const pluginsRoot = path.dirname(path.dirname(dataDir())); // <plugins>/data/<self-id> → <plugins>
    const inUse = new Set();
    try {
      const j = JSON.parse(fs.readFileSync(path.join(pluginsRoot, "installed_plugins.json"), "utf8"));
      for (const x of installedEntriesOf(j)) inUse.add(String(x.installPath).toLowerCase());
    } catch { /* 清单读不到就不做清理 */ }
    const cacheRoot = path.join(pluginsRoot, "cache");
    const at = id.lastIndexOf("@");
    const dirToClean = at > 0 ? path.join(cacheRoot, id.slice(at + 1), id.slice(0, at)) : path.join(cacheRoot, id);
    if (!dirToClean.toLowerCase().startsWith(cacheRoot.toLowerCase() + path.sep)) return { removed: [] };
    if (!fs.existsSync(dirToClean)) return { removed: [] };
    const removed = [];
    for (const ver of fs.readdirSync(dirToClean)) {
      const vd = path.join(dirToClean, ver);
      let st; try { st = fs.statSync(vd); } catch { continue; }
      if (!st.isDirectory() || inUse.has(vd.toLowerCase())) continue;
      try { fs.rmSync(vd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); removed.push(ver); } catch { /* 被占用则留给下次 */ }
    }
    // 版本目录清空后顺手收掉空父目录（cache/<市场>/<插件> 与 cache/<市场>）
    for (const d of [dirToClean, path.dirname(dirToClean)]) { try { fs.rmdirSync(d); } catch { /* 非空或不存在 */ } }
    return { removed };
  } catch (e) {
    return { removed: [], error: String(e?.message || e) };
  }
}


/* ================= REGISTRY：模型侧工具 ================= */

tool({
  name: "open_market",
  description:
    "Open the Community Market panel (community plugin marketplace) in the sidebar, which the user sees. " +
    "Use when the user wants to browse, install, update or manage ZCode plugins.",
  inputSchema: { type: "object", properties: {} },
  visibility: ["model", "app"],
  panel: true,
  openPanel: true,
  readOnly: true,
  handler: async () => ({
    text: "Community market panel opened. The user can browse, install, update and manage plugins there.",
  }),
});

tool({
  name: "search_plugins",
  description:
    "Search the community plugin catalog (curated index + GitHub zcode-plugin topic). " +
    "Returns matching plugins with install state. To install, prefer asking the user via the panel (open_market).",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Keyword to match name/description/repo. Empty = all." } },
  },
  visibility: ["model", "app"],
  readOnly: true,
  handler: async (args) => {
    const q = String(args?.query || "").toLowerCase();
    const cat = catalogWithState();
    const inst = await installedMap();
    const hits = cat.plugins
      .filter((p) => !q || [p.name, p.displayName, p.description, p.repo].join(" ").toLowerCase().includes(q))
      .map((p) => {
        const ip = inst.get(`${p.name}@${p.marketplace || ""}`) || [...inst.values()].find((i) => (i.name === p.name));
        return { name: p.name, repo: p.repo, description: p.description, stars: p.stars, category: p.category, installed: !!ip, installType: p.install?.type };
      })
      .slice(0, 30);
    return { text: JSON.stringify(hits, null, 1), structured: { results: hits } };
  },
});

tool({
  name: "install_plugin",
  description:
    "Install a community plugin by repo (owner/name, must exist in the catalog) or by exact reference (name@marketplace). " +
    "Runs marketplace add + install through the zcode CLI. Prefer open_market for interactive use.",
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "owner/name repo from the catalog, or name@marketplace reference." },
    },
    required: ["ref"],
  },
  visibility: ["model", "app"],
  readOnly: false,
  handler: async (args) => {
    const ref = String(args?.ref || "").trim();
    if (!ref) throw new Error("ref required");
    let result;
    if (ref.includes("/")) {
      const cat = catalogWithState();
      const entry = cat.plugins.find((p) => p.repo?.toLowerCase() === ref.toLowerCase());
      if (!entry) throw new Error(`repo ${ref} not in catalog; ask the user to refresh or install manually`);
      result = await installEntry(entry);
    } else {
      const out = await cli.install(ref);
      result = { ok: true, id: ref, message: out.split("\n").slice(-1)[0] || "installed" };
    }
    invalidateState();
    return { text: JSON.stringify(result), structured: result };
  },
});

tool({
  name: "list_installed",
  description: "List installed ZCode plugins with enable state and data paths.",
  inputSchema: { type: "object", properties: {} },
  visibility: ["model", "app"],
  readOnly: true,
  handler: async () => {
    const st = await getStateData(); // 走缓存；变更操作已失效重建
    const simple = (st.installed || []).map((p) => ({ id: p.id, name: p.name, version: p.version, marketplace: p.marketplace, enabled: p.enabled }));
    return { text: JSON.stringify(simple, null, 1), structured: { installed: simple } };
  },
});

/* ================= REGISTRY：面板侧工具（visibility:["app"]） ================= */

tool({
  name: "get_state",
  description: "Panel bootstrap: catalog + installed list in one call (cached; mutations invalidate).",
  inputSchema: { type: "object", properties: {} },
  visibility: ["app"],
  readOnly: true,
  handler: async () => {
    const data = await getStateData();
    return { text: "ok", structured: data };
  },
});

tool({
  name: "list_marketplaces",
  description: "List configured plugin marketplaces (id + source). Panel About tab.",
  inputSchema: { type: "object", properties: {} },
  visibility: ["app"],
  readOnly: true,
  handler: async () => {
    const mapSource = (s) => (s && (s.repo || s.url || s.path)) || "";
    let list = null;
    try {
      // FS 快路径：known_marketplaces.json（宿主 CLI 存的市场注册表），读不到回退 CLI
      const kmPath = path.join(path.dirname(path.dirname(dataDir())), "known_marketplaces.json");
      const km = JSON.parse(fs.readFileSync(kmPath, "utf8"));
      list = (km?.marketplaces || []).map((m) => ({ id: m.id ?? m.name, name: m.name, source: mapSource(m.source) }));
    } catch { /* fall through */ }
    if (!list) {
      const mkts = await cli.marketplaceList().catch(() => null);
      const raw = Array.isArray(mkts) ? mkts : mkts?.marketplaces || [];
      list = raw.map((m) => ({ id: m.id ?? m.name, name: m.name, source: mapSource(m.source) }));
    }
    return { text: "ok", structured: { marketplaces: list } };
  },
});

tool({
  name: "do_install",
  description: "Install a catalog plugin by repo (panel button).",
  inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  visibility: ["app"],
  readOnly: false,
  handler: async (args) => {
    const cat = catalogWithState();
    const entry = cat.plugins.find((p) => p.repo?.toLowerCase() === String(args.repo).toLowerCase());
    if (!entry) throw new Error(`repo not in catalog: ${args.repo}`);
    const r = await installEntry(entry);
    invalidateState();
    return { text: JSON.stringify(r), structured: r };
  },
});

tool({
  name: "do_uninstall",
  description: "Uninstall an installed plugin by id (name@marketplace).",
  inputSchema: { type: "object", properties: { id: { type: "string" }, keepData: { type: "boolean" } }, required: ["id"] },
  visibility: ["app"],
  readOnly: false,
  handler: async (args) => {
    const out = await cli.uninstall(String(args.id), { keepData: !!args.keepData });
    invalidateState();
    const cleanup = pluginCacheCleanup(String(args.id));
    const msg = out.split("\n").slice(-1)[0] || "uninstalled";
    return {
      text: out,
      structured: { ok: true, message: msg, cacheRemoved: cleanup.removed, ...(cleanup.error ? { cacheCleanupError: cleanup.error } : {}) },
    };
  },
});

tool({
  name: "do_update",
  description: "Update a plugin: refresh its marketplace manifest, then update.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  visibility: ["app"],
  readOnly: false,
  handler: async (args) => {
    const id = String(args.id);
    const mkt = id.includes("@") ? id.split("@").slice(1).join("@") : "";
    if (mkt) await cli.marketplaceUpdate(mkt).catch(() => {});
    const out = await cli.update(id);
    invalidateState();
    // 更新完成后清走旧版本目录：仅当已装清单已指向该插件且 installPath 存在时才清（防 CLI 收尾未完成时误删新版）
    let cleanup = { removed: [] };
    try {
      const pluginsRoot = path.dirname(path.dirname(dataDir()));
      const j = JSON.parse(fs.readFileSync(path.join(pluginsRoot, "installed_plugins.json"), "utf8"));
      const ent = installedEntriesOf(j).find((x) => (x.id || `${x.name}@${x.marketplace}`) === id);
      if (ent && fs.existsSync(ent.installPath)) cleanup = pluginCacheCleanup(id);
      else cleanup = { removed: [], skipped: "installed-manifest-not-ready" };
    } catch { cleanup = { removed: [], skipped: "installed-manifest-unreadable" }; }
    const msg = (out.split("\n").slice(-1)[0] || "updated") + (cleanup.removed.length ? `（已清理旧版本缓存 ${cleanup.removed.join(", ")}）` : "");
    return { text: out, structured: { ok: true, message: msg, cacheRemoved: cleanup.removed, ...(cleanup.skipped ? { cleanupSkipped: cleanup.skipped } : {}) } };
  },
});

tool({
  name: "do_toggle",
  description: "Enable or disable an installed plugin.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, enable: { type: "boolean" } },
    required: ["id", "enable"],
  },
  visibility: ["app"],
  readOnly: false,
  handler: async (args) => {
    const out = await (args.enable ? cli.enable(String(args.id)) : cli.disable(String(args.id)));
    invalidateState();
    return { text: out, structured: { ok: true, message: out.split("\n").slice(-1)[0] || "done" } };
  },
});

tool({
  name: "refresh_catalog",
  description: "Refresh the community catalog from the GitHub zcode-plugin topic (manual action). Uses the GitHub Token configured in the panel if set.",
  inputSchema: { type: "object", properties: {} },
  visibility: ["app"],
  readOnly: false,
  handler: async () => {
    const repos = await fetchGithub([], { token: githubToken() });
    const cache = refreshCache(bundledIndex, repos);
    invalidateState(); // 目录变了：合并状态里的 updateAvailable 等需重建
    return { text: `refreshed ${cache.plugins.length} plugins`, structured: { ok: true, count: cache.plugins.length, updatedAt: cache.updatedAt } };
  },
});

/* ---- 更新日志：GitHub Releases 优先，回退 README 变更段 ---- */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHANGELOG_HEAD_RE = /^(更新日志|变更记录|变更历史|变更|changelog|release notes)$/i;
function changelogSectionOf(md) {
  const lines = md.split(/\r?\n/);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,3})\s+(.*)$/.exec(lines[i]);
    if (m && CHANGELOG_HEAD_RE.test(m[2].trim())) { start = i; level = m[1].length; break; }
  }
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

tool({
  name: "get_changelog",
  description:
    "Fetch a repo's release notes: latest GitHub releases (with body text), falling back to the changelog section of its README. " +
    "Uses the panel-configured GitHub Token if set.",
  inputSchema: {
    type: "object",
    properties: { repo: { type: "string", description: "owner/name (owner/repo)" }, limit: { type: "number", description: "Max releases to return, 1-10 (default 5)." } },
    required: ["repo"],
  },
  visibility: ["model", "app"],
  readOnly: true,
  handler: async (args) => {
    const repo = String(args?.repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").replace(/\.git$/, "");
    if (!REPO_RE.test(repo)) throw new Error(`invalid repo: ${repo}`);
    const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 10);
    /* Token 无效（401）时自动匿名重试，避免一次误配拖垮全部拉取 */
    const ghApi = async (url, accept) => {
      const token = githubToken();
      const base = { "User-Agent": "zcode-community-market", Accept: accept || "application/vnd.github+json" };
      let r = await fetch(url, { headers: token ? { ...base, Authorization: `Bearer ${token}` } : base });
      if (r.status === 401 && token) r = await fetch(url, { headers: base });
      return r;
    };
    try {
      const r = await ghApi(`https://api.github.com/repos/${repo}/releases?per_page=${limit}`);
      if (r.status === 403 || r.status === 429) throw new Error(`GitHub API ${r.status} 限速（可在面板「关于」页配置 GitHub Token 后重试）`);
      if (r.ok) {
        const rels = (await r.json()).filter((x) => x && !x.draft);
        if (rels.length) {
          return {
            text: "ok",
            structured: {
              repo, source: "releases",
              releases: rels.map((x) => ({
                tag: x.tag_name || "", name: x.name || "", date: String(x.published_at || x.created_at || "").slice(0, 10),
                prerelease: !!x.prerelease, body: String(x.body || "").slice(0, 3000),
              })),
            },
          };
        }
      }
    } catch (e) {
      if (String(e?.message || e).includes("限速")) throw e;
    }
    // 回退：README 变更段（走 api.github.com：与目录刷新同一主机与鉴权，代理环境更稳）
    try {
      const r = await ghApi(`https://api.github.com/repos/${repo}/readme`, "application/vnd.github.raw");
      if (r.ok) {
        const sec = changelogSectionOf(await r.text());
        if (sec) return { text: "ok", structured: { repo, source: "readme", readmeExcerpt: sec.slice(0, 3000) } };
      }
    } catch { /* 落到 none */ }
    return { text: "ok", structured: { repo, source: "none", message: "该仓库没有 GitHub Releases，README 中也未找到更新日志段落" } };
  },
});

tool({
  name: "market_ping",
  description: "Panel bridge health check (app-only).",
  inputSchema: {
    type: "object",
    properties: { echo: { type: "string", description: "Optional text to echo back." } },
  },
  visibility: ["app"],
  readOnly: true,
  handler: async (args) => ({ text: "pong " + String(args?.echo ?? "") }),
});

/* ---- 共享设置中心（模型与面板皆可调用）---- */

tool({
  name: "settings_register",
  description:
    "Register a settings schema for a plugin in the shared settings hub (other plugins call this; users edit values in the Community Market panel's Settings tab). " +
    "schema = { title?, description?, properties: { key: { type: 'string'|'number'|'boolean', title?, description?, default?, enum? } } }. " +
    "Read values back with settings_get.",
  inputSchema: {
    type: "object",
    properties: {
      pluginId: { type: "string", description: "Your plugin id, e.g. my-plugin@my-marketplace" },
      schema: { type: "object", description: "Settings schema" },
    },
    required: ["pluginId", "schema"],
  },
  visibility: ["model", "app"],
  readOnly: false,
  handler: async (args) => { const r = settings.register(args.pluginId, args.schema); return { text: JSON.stringify(r), structured: r }; },
});

tool({
  name: "settings_list",
  description: "List plugins that registered settings in the shared hub.",
  inputSchema: { type: "object", properties: {} },
  visibility: ["model", "app"],
  readOnly: true,
  handler: async () => { const l = settings.list(); return { text: JSON.stringify(l), structured: { settings: l } }; },
});

tool({
  name: "settings_get",
  description: "Read settings values (schema + values with defaults merged) for a plugin from the shared hub.",
  inputSchema: { type: "object", properties: { pluginId: { type: "string" } }, required: ["pluginId"] },
  visibility: ["model", "app"],
  readOnly: true,
  handler: async (args) => { const r = settings.get(args.pluginId); return { text: JSON.stringify(r), structured: r }; },
});

tool({
  name: "settings_export",
  description: "All registered settings in one call: [{ pluginId, title, description, schema, values }]. Panel Settings tab renders from this single response.",
  inputSchema: { type: "object", properties: {} },
  visibility: ["model", "app"],
  readOnly: true,
  handler: () => {
    const out = [];
    for (const s of settings.list()) {
      try {
        const d = settings.get(s.pluginId);
        out.push({ pluginId: s.pluginId, title: s.title, description: s.description, schema: d.schema, values: d.values });
      } catch { /* 单个损坏不拖垮整页 */ }
    }
    return { text: "ok", structured: { settings: out } };
  },
});

tool({
  name: "settings_set",
  description: "Write settings values for a plugin into the shared hub (validated against the registered schema).",
  inputSchema: {
    type: "object",
    properties: { pluginId: { type: "string" }, values: { type: "object" } },
    required: ["pluginId", "values"],
  },
  visibility: ["model", "app"],
  readOnly: false,
  handler: async (args) => { const r = settings.set(args.pluginId, args.values); return { text: JSON.stringify(r), structured: r }; },
});

/* ---- 二期：设置页注入（补丁）管理 ---- */

import { spawn } from "node:child_process";
function runPatcher(args, timeoutMs = 600000) {
  const py = process.env.ZCODE_CMARKET_PYTHON || "python";
  const script = path.join(PLUGIN_ROOT, "patch", "patch_install.py");
  return new Promise((resolve) => {
    const p = spawn(py, [script, ...args], { windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, output: String(e) }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: (out + (err ? "\n" + err : "")).trim() }); });
  });
}

tool({
  name: "patch_status",
  description: "Status of the settings-page injection patch (asar patch + nav loader).",
  inputSchema: { type: "object", properties: {} },
  visibility: ["model", "app"],
  readOnly: true,
  handler: async () => {
    const r = await runPatcher(["status"], 60000);
    let st = {};
    try { st = JSON.parse(r.output.split("\n").filter(Boolean).pop() || "{}"); } catch { /* 非状态输出 */ }
    return { text: r.output, structured: { ok: r.ok, installed: !!st.injected, pendingTmp: !!st.pendingTmp, loaderReady: st.loaderReady !== false, asar: st.asar, error: st.error } };
  },
});

tool({
  name: "patch_install",
  description:
    "Install the settings-page injection: appends a loader line to ZCode's app.asar main entry (a file modification to the client). " +
    "After success, fully quit and reopen ZCode for it to take effect. Safe to re-run; coexists with other asar patches.",
  inputSchema: { type: "object", properties: {} },
  visibility: ["model", "app"],
  readOnly: false,
  handler: async () => {
    const r = await runPatcher(["install"]);
    return { text: r.output, structured: { ok: r.ok, output: r.output } };
  },
});

tool({
  name: "patch_remove",
  description:
    "Remove the settings-page injection (strips the loader line from app.asar) and opt out of auto re-patching. Fully quit and reopen ZCode to take effect.",
  inputSchema: { type: "object", properties: {} },
  visibility: ["model", "app"],
  readOnly: false,
  handler: async () => {
    const r = await runPatcher(["remove"]);
    return { text: r.output, structured: { ok: r.ok, output: r.output } };
  },
});

export const ALL_TOOLS = TOOLS;
