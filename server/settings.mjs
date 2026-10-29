/* 插件共享设置中心。
 * 契约（其他插件经 MCP 工具调用）：
 *   settings_register(pluginId, schema)  注册设置表单（JSON Schema 子集：string/number/boolean/enum）
 *   settings_get(pluginId)               读取设置值（含默认值合并）
 *   settings_set(pluginId, values)       写入设置值
 * 存储：${ZCODE_PLUGIN_DATA}/settings/<pluginId>.json = { schema, values, updatedAt }
 * 每个文件原子写（tmp+rename），pluginId 仅允许 [A-Za-z0-9_.@-]。 */
"use strict";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./catalog.mjs";

const ID_RE = /^[A-Za-z0-9_.@-]{1,120}$/;
const dir = () => path.join(dataDir(), "settings");
const fileOf = (id) => path.join(dir(), id + ".json");

function normalize(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`invalid pluginId: ${JSON.stringify(id)}`);
  return id;
}

function readStore(id) {
  try { return JSON.parse(fs.readFileSync(fileOf(id), "utf8")); } catch { return { schema: null, values: {} }; }
}
function writeStore(id, store) {
  fs.mkdirSync(dir(), { recursive: true });
  const f = fileOf(id);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, f);
}

/* schema 校验（宽松）：{ title?, description?, properties: { key: {type, title?, description?, default?, enum?} } } */
function validateSchema(schema) {
  if (!schema || typeof schema !== "object" || typeof schema.properties !== "object")
    throw new Error("schema must be an object with a properties map");
  for (const [k, v] of Object.entries(schema.properties)) {
    if (!["string", "number", "boolean"].includes(v?.type)) throw new Error(`property ${k}: unsupported type ${v?.type}`);
    if (v.enum && !Array.isArray(v.enum)) throw new Error(`property ${k}: enum must be an array`);
  }
}

function coerce(value, prop) {
  if (prop.enum && !prop.enum.includes(value)) throw new Error(`value not in enum: ${JSON.stringify(value)}`);
  const t = typeof value;
  if (prop.type === "number") { if (t !== "number" || !Number.isFinite(value)) throw new Error("expected number"); return value; }
  if (prop.type === "boolean") { if (t !== "boolean") throw new Error("expected boolean"); return value; }
  if (t !== "string") throw new Error("expected string");
  return value;
}

export const settings = {
  register(pluginId, schema) {
    const id = normalize(pluginId);
    validateSchema(schema);
    const store = readStore(id);
    store.schema = schema;
    // 合并默认值（不覆盖已有值；剔除 schema 已移除的键）
    const merged = {};
    for (const [k, prop] of Object.entries(schema.properties)) {
      merged[k] = store.values[k] !== undefined ? store.values[k] : (prop.default ?? null);
    }
    store.values = merged;
    writeStore(id, store);
    return { pluginId: id, properties: Object.keys(schema.properties) };
  },
  list() {
    try {
      return fs
        .readdirSync(dir())
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const s = readStore(f.slice(0, -5));
          return {
            pluginId: f.slice(0, -5),
            title: s.schema?.title || f.slice(0, -5),
            description: s.schema?.description || "",
            keys: Object.keys(s.schema?.properties || {}),
            updatedAt: s.updatedAt || null,
          };
        });
    } catch { return []; }
  },
  get(pluginId) {
    const id = normalize(pluginId);
    const s = readStore(id);
    if (!s.schema) throw new Error(`no settings registered for ${id}`);
    return { pluginId: id, schema: s.schema, values: s.values };
  },
  set(pluginId, values) {
    const id = normalize(pluginId);
    if (!values || typeof values !== "object") throw new Error("values must be an object");
    const s = readStore(id);
    if (!s.schema) throw new Error(`no settings registered for ${id}`);
    const out = { ...s.values };
    for (const [k, v] of Object.entries(values)) {
      const prop = s.schema.properties[k];
      if (!prop) continue; // schema 外的键忽略
      out[k] = coerce(v, prop);
    }
    s.values = out;
    writeStore(id, s);
    return { pluginId: id, values: out };
  },
};
