/* zcode-community-market 渲染端 v2：设置页导航注入 + 面板挂载 + iframe 消息中继。
 * 由 cmarket-loader.cjs 注入宿主页面执行（非模块，普通 IIFE 体）。
 * v2 要点：
 * - 导航项插进左侧导航列表（main 容器）内，样式克隆自现有条目；
 * - 面板只覆盖右侧内容区（挂在 content-frame 的定位容器内），左侧导航可点 → 天然“返回”；
 * - 回执按请求 id 路由到发起时的 contentWindow，杜绝陈旧 iframeEl 引用丢回执；
 * - Esc 关闭；React 重渲染由 data 标记 + MutationObserver + 600ms 对账兜底重挂。 */
(function () {
  /* 清掉 v1 遗留物（升级热注入时） */
  try {
    document.querySelectorAll("#cmarket-settings-nav, #cmarket-panel-host, [data-cmarket]").forEach(function (n) { n.remove(); });
  } catch (e) {}
  if (window.__cmarketNavV2) return;
  window.__cmarketNavV2 = true;
  window.__cmarketNavInstalled = true; // 兼容 v1 的已安装标记

  var NAV_LABEL = "社区插件市场";
  var NAV_ID = "cmarket-settings-nav";
  var HOST_ID = "cmarket-panel-host";

  /* ---------- 请求队列与回执路由（与主进程 loader 的轮询协议） ---------- */
  window.__cmarketRequests = window.__cmarketRequests || [];
  var liveIframe = null;          // 当前面板 iframe（仅用于加载态判断）
  var winByReqId = new Map();     // iframe 请求 id → contentWindow（按 id 精确路由回执）

  window.__cmarketResult = function (raw) {
    var m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.__src === "iframe" && m.id != null && winByReqId.has(m.id)) {
      var w = winByReqId.get(m.id);
      winByReqId.delete(m.id);
      try { w && w.postMessage(m, "*"); } catch (e) {}
      return;
    }
    if (m.id != null && navPending.has(m.id)) {
      var p = navPending.get(m.id); navPending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message || "rpc error")) : p.resolve(m.result);
    }
  };

  /* iframe 面板 → postMessage(parent) → 中继进请求队列 */
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.jsonrpc !== "2.0" || d.id == null) return; // 请求才转发；通知忽略
    if (!ev.source || !isOurPanelWindow(ev.source)) return; // 只中继自家面板
    winByReqId.set(d.id, ev.source);
    d.__src = "iframe";
    window.__cmarketRequests.push(d);
  });

  function isOurPanelWindow(win) {
    // 面板 iframe 的 src 是 runtime panel.html；遍历本页 iframe 匹配 contentWindow
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === win && /zcode-community-market[\\/]panel\.html/.test(frames[i].src || "")) return true;
    }
    return false;
  }

  var nextRpcId = 1;
  var navPending = new Map();
  function navCall(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = "nav-" + nextRpcId++;
      navPending.set(id, { resolve: resolve, reject: reject });
      window.__cmarketRequests.push({ jsonrpc: "2.0", id: id, method: method, params: params || {}, __src: "nav" });
      setTimeout(function () {
        if (navPending.has(id)) { navPending.delete(id); reject(new Error(method + " 超时")); }
      }, timeoutMs || 60000);
    });
  }

  /* ---------- 设置页 DOM ---------- */
  function settingsRoot() { return document.querySelector('[data-testid="settings-page"]'); }
  function navFrame() { return document.querySelector("[data-settings-panel-frame]"); }
  function contentFrame() { return document.querySelector("[data-settings-content-frame]"); }
  function styleOf(el, props) { for (var k in props) { try { el.style[k] = props[k]; } catch (e) {} } }

  /* 左侧分节导航：克隆「插件」条目（BUTTON[data-testid=settings-section-nav-plugin]）插到它后面 */
  function navProto() {
    return (
      document.querySelector('[data-testid="settings-section-nav-plugin"]') ||
      document.querySelector('button[data-testid^="settings-section-nav-"]')
    );
  }

  function buildNavItem() {
    var proto = navProto();
    if (!proto) return null;
    var el = proto.cloneNode(true); // DOM 克隆：样式/图标/结构与原生条目一致
    el.id = NAV_ID;
    el.setAttribute("data-cmarket", "nav");
    el.setAttribute("data-testid", "settings-section-nav-community-market");
    el.removeAttribute("data-state");
    el.removeAttribute("aria-current");
    var label = el.querySelector(".truncate") || el.lastElementChild;
    if (label) label.textContent = NAV_LABEL;
    // 第一个子节点若是图标，替换为 🛒
    var icon = el.children[0];
    if (icon && icon !== label) icon.textContent = "🛒";
    return el;
  }

  function navHost() {
    var proto = navProto();
    if (!proto || !proto.parentElement) return null;
    return proto.parentElement; // 「插件」所在分组（Agent 能力）
  }

  function isActive() { var n = document.getElementById(NAV_ID); return !!(n && n.getAttribute("data-active")); }

  var settingsMissCount = 0;
  function ensureNav() {
    var root = settingsRoot(), frame = navFrame();
    if (!root || !frame) {
      // 防抖：连续 2 个周期（≥1.2s）都不在设置页才收起，避免 React 过渡瞬间误关
      if (++settingsMissCount >= 2) hidePanel();
      return;
    }
    settingsMissCount = 0;
    var host = navHost();
    if (!host) { if (++settingsMissCount >= 2) hidePanel(); return; }
    var existing = document.getElementById(NAV_ID);
    if (existing && existing.parentElement === host) return;
    if (existing) existing.remove();
    var item = buildNavItem();
    if (!item) return;
    var proto = navProto();
    if (proto && proto.nextSibling) host.insertBefore(item, proto.nextSibling);
    else host.appendChild(item);
    var nav = host.closest("nav") || host;
    if (!nav.__cmarketClickBound) {
      nav.__cmarketClickBound = true;
      nav.addEventListener("click", function (e) {
        if (e.target && e.target.closest && e.target.closest("#" + NAV_ID)) return;
        hidePanel(); // 点其它分节 → 收起面板（返回）
      }, true);
    }
  }

  /* ---------- 面板挂载（仅覆盖右侧内容区） ---------- */
  function rightPaneRect() {
    // 实测：[data-settings-panel-frame] 即右侧内容区（左导航是另一个 NAV 侧栏）
    var pane = navFrame();
    if (!pane) return null;
    var r = pane.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  function togglePanel() {
    if (document.getElementById(HOST_ID)) { hidePanel(); return; }
    var item = document.getElementById(NAV_ID);
    if (item) { item.setAttribute("data-active", "1"); styleOf(item, { background: "var(--color-bg-2, rgba(127,127,127,.16))", color: "var(--color-primary, #2f6fdb)", fontWeight: "600" }); }
    showPanel();
  }

  function showPanel() {
    if (document.getElementById(HOST_ID)) return;
    if (!window.__CMARKET_PANEL_URL) return;
    var rect = rightPaneRect();
    if (!rect) return;
    var host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-cmarket", "panel");
    applyHostRect(host, rect);
    styleOf(host, { zIndex: "30", background: "var(--color-bg-1, #fff)", display: "flex", flexDirection: "column" });
    var tip = document.createElement("div");
    tip.textContent = "社区插件市场加载中…（Esc 关闭）";
    styleOf(tip, { padding: "24px", color: "var(--color-text-3, #888)", fontSize: "13px" });
    var fr = document.createElement("iframe");
    styleOf(fr, { flex: "1", width: "100%", border: "0", display: "block", background: "transparent" });
    fr.src = window.__CMARKET_PANEL_URL;
    fr.addEventListener("load", function () { try { tip.remove(); } catch (e) {} });
    host.appendChild(tip);
    host.appendChild(fr);
    document.body.appendChild(host);
    liveIframe = fr;
  }

  function hidePanel() {
    var item = document.getElementById(NAV_ID);
    if (item) { item.removeAttribute("data-active"); styleOf(item, { background: "transparent", color: "var(--color-text-1, inherit)", fontWeight: "" }); }
    var host = document.getElementById(HOST_ID);
    if (host) host.remove();
    liveIframe = null;
    winByReqId.clear();
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && document.getElementById(HOST_ID)) hidePanel();
  }, true);

  /* 事件委托：条目节点可能被 React 重建，监听绑在 document 上永不丢失 */
  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest("#" + NAV_ID)) {
      e.stopPropagation();
      e.preventDefault();
      togglePanel();
    }
  }, true);

  function applyHostRect(host, r) {
    styleOf(host, {
      position: "fixed",
      left: r.left + "px", top: r.top + "px",
      width: (r.right - r.left) + "px", height: (r.bottom - r.top) + "px",
    });
  }
  function syncHostRect() {
    var host = document.getElementById(HOST_ID);
    if (!host) return;
    var r = rightPaneRect();
    if (r) applyHostRect(host, r);
  }
  window.addEventListener("resize", syncHostRect);

  /* ---------- 对账：React 重渲染后重挂 ---------- */
  var mo = new MutationObserver(function () { ensureNav(); });
  function startObserver() {
    var body = document.body;
    if (!body) { setTimeout(startObserver, 300); return; }
    mo.observe(body, { childList: true, subtree: true });
  }
  startObserver();
  setInterval(function () { ensureNav(); syncHostRect(); }, 600);
  ensureNav();
})();
