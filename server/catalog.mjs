/* 目录聚合：内置精选索引 + GitHub topic 刷新 + 本机已装/可装状态合并。 */
"use strict";
import fs from "node:fs";
import path from "node:path";

export function dataDir() {
  if (process.env.ZCODE_PLUGIN_DATA) return process.env.ZCODE_PLUGIN_DATA;
  const storage = process.env.ZCODE_STORAGE_DIR || path.join(process.env.USERPROFILE || process.env.HOME, ".zcode", "cli");
  return path.join(storage, "plugins", "data", "zcode-community-market@zcode-community-market");
}

const CACHE_PATH = () => path.join(dataDir(), "catalog-cache.json");

export function loadBundledIndex(pluginRoot) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, "data", "community-index.json"), "utf8"));
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH(), "utf8")); } catch { return null; }
}
function saveCache(c) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = CACHE_PATH() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CACHE_PATH());
}

/* GitHub topic 刷新（手动触发；token 优先取设置中心配置，环境变量 GITHUB_TOKEN 兜底） */
export async function fetchGithub(extraRepos = [], { token } = {}) {
  const repos = [];
  const bearer = token || process.env.GITHUB_TOKEN || null;
  const headers = {
    "User-Agent": "zcode-community-market",
    Accept: "application/vnd.github+json",
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
  const urls = [
    "https://api.github.com/search/repositories?q=topic:zcode-plugin&sort=stars&order=desc&per_page=100",
  ];
  for (const url of urls) {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`GitHub API ${r.status}: ${r.statusText}（匿名限速时可在面板「关于」页配置 GitHub Token，或设环境变量 GITHUB_TOKEN）`);
    const j = await r.json();
    for (const it of j.items || []) repos.push(it);
  }
  for (const full of extraRepos) {
    try {
      const r = await fetch(`https://api.github.com/repos/${full}`, { headers });
      if (r.ok) repos.push(await r.json());
    } catch { /* 单个失败忽略 */ }
  }
  return repos.map((r) => ({
    repo: r.full_name,
    stars: r.stars ?? 0,
    description: r.description ?? "",
    homepage: r.homepage || undefined,
    pushedAt: r.pushed_at ?? "",
    archived: !!r.archived,
  }));
}

/* 刷新：GitHub 结果合并进缓存；内置条目（按 repo）永远优先保留 */
export function refreshCache(bundled, githubRepos) {
  const prev = loadCache() ?? { updatedAt: "", plugins: [] };
  const byRepo = new Map();
  for (const p of prev.plugins) if (p.repo) byRepo.set(p.repo, p);
  for (const g of githubRepos) {
    const b = bundled.plugins.find((p) => p.repo === g.repo);
    if (b) {
      byRepo.set(g.repo, { ...b, stars: g.stars, starsUpdatedAt: g.pushedAt });
    } else {
      const existing = byRepo.get(g.repo) || {};
      byRepo.set(g.repo, {
        ...existing,
        name: existing.name || g.repo.split("/")[1],
        displayName: existing.displayName || g.repo.split("/")[1],
        repo: g.repo,
        description: g.description || existing.description || "",
        stars: g.stars,
        category: existing.category || "other",
        unverified: true,
        install:
          existing.install && existing.install.type !== "marketplace-try"
            ? existing.install
            : { type: "marketplace-try", source: g.repo, pluginName: g.repo.split("/")[1] },
      });
    }
  }
  const cache = {
    updatedAt: new Date().toISOString(),
    plugins: [...byRepo.values()].sort((a, b) => (b.stars || 0) - (a.stars || 0)),
  };
  saveCache(cache);
  return cache;
}

export function mergedCatalog(bundled) {
  const cache = loadCache();
  const byRepo = new Map();
  if (cache) for (const p of cache.plugins) byRepo.set(p.repo, p);
  // 内置索引为准（可随插件升级更新条目），缓存补充 star 数与 GitHub 新条目
  const out = bundled.plugins.map((p) => ({ ...p, ...(byRepo.get(p.repo) || {}), ...p, stars: byRepo.get(p.repo)?.stars ?? p.stars ?? null }));
  const bundledRepos = new Set(bundled.plugins.map((p) => p.repo));
  for (const p of byRepo.values()) if (!bundledRepos.has(p.repo)) out.push(p);
  out.sort((a, b) => (b.stars || 0) - (a.stars || 0));
  return { updatedAt: cache?.updatedAt ?? null, plugins: out };
}
