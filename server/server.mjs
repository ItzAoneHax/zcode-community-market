/* zcode-community-market MCP server (stdio) — 协议层。
 * 工具与业务逻辑在 core.mjs；面板资源在本文件注册。 */
"use strict";
import fs from "node:fs";
import path from "node:path";
import { ALL_TOOLS as TOOLS, PLUGIN_VERSION, log } from "./core.mjs";

const PANEL_URI = "ui://community-market/panel.html";
const HTML_MIME = "text/html;profile=mcp-app";
const SERVER_NAME = "community-market";
const SERVER_VERSION = PLUGIN_VERSION;
const PLUGIN_ROOT = path.dirname(import.meta.dirname);

const RESOURCES = [
  {
    name: "panel",
    uri: PANEL_URI,
    mimeType: HTML_MIME,
    _meta: { "zcode/csp": {} },
    read: async () => fs.promises.readFile(path.join(PLUGIN_ROOT, "dist", "ui", "panel.html"), "utf8"),
  },
];

function toolDescriptor(t) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: t.readOnly ?? true },
    _meta: {
      ui: t.panel
        ? { resourceUri: PANEL_URI, surface: "community-market", visibility: t.visibility }
        : { visibility: t.visibility },
      ...(t.openPanel ? { "openai/ui": { preferredModelDisplayMode: "fullscreen" } } : {}),
    },
  };
}

const methods = {
  initialize: (params) => ({
    protocolVersion: params?.protocolVersion ?? "2025-06-18",
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  }),
  ping: () => ({}),
  "tools/list": () => ({ tools: TOOLS.map(toolDescriptor) }),
  "tools/call": async (params) => {
    const t = TOOLS.find((x) => x.name === params?.name);
    if (!t) return { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true };
    try {
      const r = await t.handler(params.arguments ?? {});
      return {
        content: [{ type: "text", text: String(r.text ?? "") }],
        ...(r.structured ? { structuredContent: r.structured } : {}),
      };
    } catch (e) {
      log(`tool ${t.name} error:`, e?.stack ?? e);
      return { content: [{ type: "text", text: `[${t.name}] ${e?.message ?? e}` }], isError: true };
    }
  },
  "resources/list": () => ({
    resources: RESOURCES.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType, _meta: r._meta })),
  }),
  "resources/read": async (params) => {
    const r = RESOURCES.find((x) => x.uri === params?.uri);
    if (!r) throw new Error(`Unknown resource: ${params?.uri}`);
    const text = await r.read();
    return { contents: [{ uri: r.uri, mimeType: r.mimeType, text, _meta: r._meta }] };
  },
};

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("bad json line:", line.slice(0, 200)); continue; }
    handle(msg).catch((e) => log("handler error:", e?.stack ?? e));
  }
});
process.stdin.on("end", () => process.exit(0));

async function handle(msg) {
  if (msg?.jsonrpc !== "2.0") return;
  if (msg.id == null) return;
  const fn = methods[msg.method];
  if (!fn) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    return;
  }
  try {
    send({ jsonrpc: "2.0", id: msg.id, result: await fn(msg.params ?? {}) });
  } catch (e) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e?.message ?? String(e) } });
  }
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
log(`server up (root=${PLUGIN_ROOT})`);
