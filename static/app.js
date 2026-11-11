/* AI 动画工作台 · 手机版逻辑
 * 数据全部存云端 SQLite（/api/projects），浏览器只是遥控器。
 * 生成链路：头脑风暴/点子 → /api/generate-story → 分镜逐条 /api/generate-image
 *          → /api/generate-video + 轮询 /api/video-status → /api/save-video
 */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (s) => DOMPurify.sanitize(marked.parse(String(s || "")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  code: localStorage.getItem("access_code") || "",
  role: localStorage.getItem("access_role") || "",      // admin | partition
  zone: localStorage.getItem("access_zone") || "",      // 分区显示名
  projects: [],
  cur: null,          // {id, name, data}
  tab: "story",
  assetTab: "characters",
  manage: false,
  saveTimer: null,
  dirty: false,
  pollers: {},        // boardId -> intervalId
  chatImages: [],     // 头脑风暴待发送图片（dataURL）
  refTarget: null,    // 参考图上传目标 {kind, index}
};

/* ================= 网络层 ================= */
async function api(path, body, method) {
  method = method || (body !== undefined ? "POST" : "GET");
  const headers = { "x-access-code": S.code };
  if (body !== undefined) headers["content-type"] = "application/json";
  const resp = await fetch(path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401) { showLogin(); throw new Error("需要访问口令"); }
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  if (!resp.ok) throw new Error(data.detail || `请求失败（HTTP ${resp.status}）`);
  return data;
}

/* ================= 遮罩 / 提示 ================= */
let toastTimer = null;
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), isErr ? 5000 : 2600);
}
function showBusy(text, sub) {
  $("busy-text").textContent = text || "生成中…";
  $("busy-sub").textContent = sub || "";
  $("busy-mask").classList.remove("hidden");
}
function hideBusy() { $("busy-mask").classList.add("hidden"); }

/* ================= 登录 ================= */
function showLogin() {
  $("login-screen").classList.remove("hidden");
  $("home-screen").classList.add("hidden");
  $("studio-screen").classList.add("hidden");
}
async function doLogin() {
  const code = $("login-code").value.trim();
  if (!code) return;
  try {
    const r = await api("/api/login", { code });
    S.code = code;
    S.role = r.role || "partition";
    S.zone = r.zone || "";
    localStorage.setItem("access_code", code);
    localStorage.setItem("access_role", S.role);
    localStorage.setItem("access_zone", S.zone);
    $("login-screen").classList.add("hidden");
    $("login-err").classList.add("hidden");
    await loadHome();
    showZoneBadge();
    $("home-screen").classList.remove("hidden");
  } catch (e) {
    $("login-err").classList.remove("hidden");
  }
}
/* 顶栏显示当前分区身份（管理员金色，分区紫色） */
function showZoneBadge() {
  const el = $("zone-badge");
  if (!el) return;
  if (!S.code) { el.classList.add("hidden"); return; }
  el.textContent = S.role === "admin" ? "管理员" : (S.zone || "分区");
  el.classList.toggle("zone-admin", S.role === "admin");
  el.classList.remove("hidden");
}
/* 退出当前账户：清口令回到登录页（云端数据不动，换口令登录即切换分区） */
function logoutUser() {
  if (!confirm("退出当前账户？\n项目数据都保存在云端，换口令登录即可进入对应分区。")) return;
  ["access_code", "access_role", "access_zone"].forEach((k) => localStorage.removeItem(k));
  location.reload();
}
$("login-code") && $("login-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});

/* ================= 首页 ================= */
async function loadHome() {
  const r = await api("/api/projects");
  S.projects = r.projects || [];
  renderHome();
}
function renderHome() {
  const list = $("project-list");
  $("btn-manage").textContent = S.manage ? "完成" : "⋯";
  if (!S.projects.length) {
    list.innerHTML = `<div class="card pad" style="text-align:center;color:var(--muted);font-size:13.5px;">
      还没有项目<br>点上面的「新建动画项目」开始创作吧</div>`;
    return;
  }
  list.innerHTML = S.projects.map((p) => `
    <div class="project-card" onclick="openProject('${p.id}')">
      <div class="project-cover">${p.cover ? `<img src="${p.cover}" loading="lazy">` : "🎬"}</div>
      <div class="project-meta">
        <div class="project-name">${esc(p.name)}</div>
        <div class="project-sub">${p.board_count || 0} 个分镜 · ${fmtRel(p.updated_at)}${p.owner && p.owner !== S.code && p.owner_label ? ` · ${esc(p.owner_label)}` : ""}</div>
      </div>
      ${S.manage ? `<button class="proj-del" onclick="event.stopPropagation();deleteProject('${p.id}')">🗑</button>` : ""}
    </div>`).join("");
}
function toggleManage() { S.manage = !S.manage; renderHome(); }
function fmtRel(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = Date.now(), diff = now - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  const pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff < 86400000) return "今天 " + hm;
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}
function showNewProject() {
  openSheet(`
    <div class="sheet-title">新建动画项目</div>
    <div class="sheet-sub">先起个名字，随时可以改</div>
    <input id="np-name" type="text" placeholder="例如：橘猫大侠" maxlength="30">
    <button class="btn btn-primary btn-block" onclick="createNew()">创建</button>`);
  setTimeout(() => $("np-name").focus(), 250);
}
async function createNew() {
  const name = ($("np-name").value || "").trim() || "未命名项目";
  try {
    const r = await api("/api/projects", { name, data: { name, story: null, boards: [] } });
    closeSheet();
    await openProject(r.id);
  } catch (e) { toast(e.message, true); }
}
async function deleteProject(id) {
  const p = S.projects.find((x) => x.id === id);
  if (!confirm(`确定删除项目「${p?.name || id}」？\n项目数据删除后无法恢复（生成的图片视频文件仍保留在服务器上）。`)) return;
  try {
    await api(`/api/projects/${id}`, undefined, "DELETE");
    toast("已删除");
    await loadHome();
  } catch (e) { toast(e.message, true); }
}

/* ================= 项目打开 / 保存 ================= */
function normalizeData(d) {
  // 兼容自愈：老版本后端曾把字段存成字符串（images:"[]" / videoUrl:"None"），会导致
  // <video src="None"> 报「视频不存在」、分镜渲染崩溃。打开项目时统一修正。
  if (!d || typeof d !== "object") return d;
  const cleanStr = (v) => (v === "None" || v === "null" || v === "" ? null : v);
  if (Array.isArray(d.boards)) d.boards = d.boards.map((b) => {
    if (!b || typeof b !== "object") return b;
    if (!Array.isArray(b.images)) {
      let imgs = b.images;
      if (typeof imgs === "string") { try { imgs = JSON.parse(imgs); } catch (_) { imgs = []; } }
      b.images = Array.isArray(imgs) ? imgs.filter((u) => typeof u === "string" && u) : [];
    }
    b.videoUrl = cleanStr(b.videoUrl);
    b.videoTaskId = cleanStr(b.videoTaskId);
    b.videoStatus = cleanStr(b.videoStatus);
    b.videoError = cleanStr(b.videoError);
    b.topView = cleanStr(b.topView);
    b.trajView = cleanStr(b.trajView);
    if (b.videoStatus === "running" && !b.videoTaskId) b.videoStatus = "failed";
    return b;
  });
  if (!Array.isArray(d.boards)) d.boards = [];
  return d;
}
async function openProject(id) {
  try {
    const r = await api(`/api/projects/${id}`);
    S.cur = { id: r.id, name: r.name, data: normalizeData(r.data || {}) };
    S.cur.data.boards ||= [];
    S.cur.data.name ||= r.name;
    $("studio-name").textContent = S.cur.name;
    setSaveState("");
    $("home-screen").classList.add("hidden");
    $("studio-screen").classList.remove("hidden");
    resumePollers();
    setTab("story");
  } catch (e) { toast(e.message, true); }
}
function backHome() {
  saveNow();
  $("studio-screen").classList.add("hidden");
  $("home-screen").classList.remove("hidden");
  loadHome().catch(() => {});
}
function setSaveState(text, saving) {
  const el = $("save-state");
  el.textContent = text;
  el.className = "save-state" + (saving ? " saving" : "");
}
function touch() {
  if (!S.cur) return;
  S.dirty = true;
  setSaveState("保存中…", true);
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, 1200);
}
async function saveNow() {
  if (!S.cur || !S.dirty) return;
  clearTimeout(S.saveTimer);
  // 落库瘦身：聊天附图的 base64 dataURL 只用于当次展示，不写进数据库（体积太大）
  let payload = S.cur.data;
  try {
    payload = JSON.parse(JSON.stringify(S.cur.data));
    if (payload.draft && payload.draft.messages) {
      for (const m of payload.draft.messages) delete m.image;
    }
  } catch (_) {}
  try {
    const r = await api(`/api/projects/${S.cur.id}`, { name: S.cur.name, data: payload });
    S.dirty = false;
    setSaveState("已保存 " + new Date(r.updated_at).toTimeString().slice(0, 5));
  } catch (e) { setSaveState("保存失败，稍后重试"); }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveNow();
  else if (S.cur) resumePollers(); // 回到前台：重启丢失的轮询、清理无任务 ID 的僵尸"渲染中"
});

/* ================= 底部 Tab ================= */
const TAB_RENDER = {
  story: renderStory, assets: renderAssets, boards: renderBoards, settings: renderSettings,
};
function setTab(t) {
  S.tab = t;
  document.querySelectorAll(".tab-page").forEach((el) => el.classList.add("hidden"));
  $("tab-" + t).classList.remove("hidden");
  document.querySelectorAll(".tabbar-item").forEach((el) =>
    el.classList.toggle("active", el.dataset.tab === t));
  $("studio-body").scrollTop = 0;
  TAB_RENDER[t] && TAB_RENDER[t]();
}

/* ================= 故事页 ================= */
function renderStory() {
  const d = S.cur.data;
  const hasStory = !!d.story;
  $("story-create").classList.toggle("hidden", hasStory);
  $("story-view").classList.toggle("hidden", !hasStory);
  // 生成剧本后不再隐藏头脑风暴：可通过「💬 头脑风暴对话」按钮展开继续聊
  const showChat = !!(d.draft && d.draft.messages.length) && (S.showBrainstorm || !hasStory);
  $("brainstorm-wrap").classList.toggle("hidden", !showChat);
  const chatBtn = $("btn-brainstorm-toggle");
  if (chatBtn) chatBtn.classList.toggle("hidden", !hasStory);
  if (hasStory) {
    const st = d.story;
    $("story-hook").textContent = "「" + (st.hook || "…") + "」";
    $("story-synopsis").textContent = st.synopsis || "";
    $("story-style").textContent = st.style_bible || "";
    $("story-stats").innerHTML = [
      ["characters", "角色"], ["scenes", "场景"], ["props", "道具"],
    ].map(([k, label]) => `<div class="stat-chip"><div class="stat-num">${(st[k] || []).length}</div><div class="stat-label">${label}</div></div>`).join("")
      + `<div class="stat-chip"><div class="stat-num">${d.boards.length}</div><div class="stat-label">分镜</div></div>`;
  } else if (d.draft && d.draft.messages.length) {
    renderChat();
  }
}
function toggleBrainstorm() {
  const d = S.cur?.data;
  if (!d) return;
  if (!(d.draft && d.draft.messages.length)) {
    // 还没有对话记录：直接开一段新的头脑风暴
    openBrainstorm();
    return;
  }
  S.showBrainstorm = !S.showBrainstorm;
  renderStory();
  if (S.showBrainstorm) {
    renderChat();
    const list = $("chat-list");
    if (list) list.scrollTop = list.scrollHeight;
  }
}
function openIdeaInput() {
  $("idea-input-wrap").classList.remove("hidden");
  $("idea-input").focus();
}
async function genStoryFromIdea() {
  const idea = $("idea-input").value.trim();
  if (!idea) return toast("先写点什么吧", true);
  showBusy("正在创作剧本…", "生成角色、场景、分镜与全部提示词，约 1–2 分钟");
  try {
    const story = await api("/api/generate-story", { idea });
    S.showBrainstorm = false;
    applyStory(story);
    hideBusy();
    toast("剧本完成！去「角色场景」出设定图，再到「分镜」逐镜生成");
  } catch (e) { hideBusy(); toast(e.message, true); }
}
function applyStory(story) {
  const d = S.cur.data;
  // 资产继承：新剧本的同名角色/场景/道具，继承旧参考图(ref_images)与设定图(image_url)。
  // 手动删除过的（delRef 从旧数组里移除）不会回来；改了名字的角色视为新角色，不带旧图。
  const prev = d.story_assets || d.story || null;
  if (prev) {
    for (const k of ["characters", "scenes", "props"]) {
      const olds = prev[k] || [], news = story[k] || [];
      for (const it of news) {
        if (!it || !it.name) continue;
        const o = olds.find((x) => x && x.name === it.name);
        if (!o) continue;
        if (o.ref_images && o.ref_images.length) it.ref_images = o.ref_images.slice();
        if (o.image_url) it.image_url = o.image_url;
      }
    }
  }
  delete d.story_assets;
  d.story = story;
  d.boards = (story.storyboards || []).map((sb, i) => ({
    id: "b" + (sb.shot_number || i + 1) + "_" + Math.random().toString(36).slice(2, 7),
    shot_number: sb.shot_number || i + 1,
    description: sb.description || "",
    dialogue: sb.dialogue || "",
    duration: sb.duration || 3,
    image_prompt: sb.image_prompt || "",
    video_prompt: sb.video_prompt || "",
    images: [],
    videoUrl: null,
    videoTaskId: null,
    videoStatus: null,
  }));
  delete story.storyboards;
  S.cur.name = S.cur.name === "未命名项目" ? (story.hook || S.cur.name).slice(0, 20) : S.cur.name;
  $("studio-name").textContent = S.cur.name;
  touch();
  renderStory();
}
async function genStoryFromChat() {
  const d = S.cur.data;
  if (d.story && !confirm("根据头脑风暴重新生成剧本会覆盖当前剧本与分镜进度（角色/场景/道具的参考图会继承到同名条目），确定继续吗？")) return;
  showBusy("正在创作剧本…", "把头脑风暴的成果整理成完整剧本，约 1–2 分钟");
  try {
    const story = await api("/api/generate-story", {
      idea: "根据头脑风暴对话生成",
      chat_history: (d.draft.messages || []).map((m) => ({ role: m.role, content: m.content })),
    });
    S.showBrainstorm = false;
    applyStory(story);
    hideBusy();
    toast("剧本完成！");
  } catch (e) { hideBusy(); toast(e.message, true); }
}
async function regenStory() {
  if (!confirm("重新生成会覆盖当前剧本与全部分镜进度（角色/场景/道具的参考图与设定图会保留到新剧本的同名条目上；已生成的图片视频文件仍保留），确定吗？")) return;
  // 先把旧资产（参考图/设定图）暂存，供 applyStory 按名字继承
  const s = S.cur.data.story || {};
  S.cur.data.story_assets = {
    characters: s.characters || [], scenes: s.scenes || [], props: s.props || [],
  };
  S.cur.data.story = null;
  S.cur.data.boards = [];
  S.cur.data.draft = null;
  touch();
  renderStory();
  toast("已清空，重新开始创作");
}

/* ---------- 头脑风暴 ---------- */
function openBrainstorm() {
  const d = S.cur.data;
  d.draft ||= { messages: [], ready: false };
  $("idea-input-wrap").classList.add("hidden");
  S.showBrainstorm = true; // 剧本已生成时也允许展开对话继续聊
  if (!d.draft.messages.length) {
    d.draft.messages.push({ role: "user", content: "我想做一个动画短片，请开始引导我。" });
    touch();
    renderStory();          // draft 已有消息 → renderStory 会显示聊天框
    sendChat(true);         // 只发 AI 请求，不再重复插消息
  } else {
    renderStory();
  }
}
function renderChat() {
  const wrap = $("brainstorm-wrap");
  const msgs = S.cur.data.draft ? S.cur.data.draft.messages : [];
  wrap.classList.toggle("hidden", !msgs.length);
  $("chat-list").innerHTML = msgs.map((m) => `
    <div class="chat-msg ${m.role === "user" ? "user" : "ai"}">
      <div class="bubble">
        ${m.role === "ai" ? md(m.content) : esc(m.content)}
        ${m.image ? `<img src="${m.image}">` : ""}
      </div>
    </div>`).join("");
  $("ready-banner").classList.toggle("hidden", !(S.cur.data.draft && S.cur.data.draft.ready));
  $("chat-list").scrollTop = $("chat-list").scrollHeight;
}
async function sendChat(isFirst) {
  const d = S.cur.data.draft;
  if (!d) return;
  const input = $("chat-input");
  const dataUrls = S.chatImages.splice(0);
  const b64s = dataUrls.map((u) => u.split(",")[1]);
  let text = input.value.trim();
  let pushed = false;              // 本次是否插入了用户消息（失败时只回滚它自己）
  if (isFirst) {
    text = d.messages.length ? d.messages[d.messages.length - 1].content
                             : "我想做一个动画短片，请开始引导我。";
  } else {
    if (!text && !dataUrls.length) return;
    const msg = { role: "user", content: text || "（见图）" };
    if (dataUrls.length) msg.image = dataUrls[0];
    d.messages.push(msg);
    pushed = true;
    input.value = "";
  }
  renderChat();
  $("chat-send").disabled = true;
  try {
    const r = await api("/api/brainstorm", {
      step: d.messages.filter((m) => m.role === "user").length,
      messages: d.messages.map((m) => ({ role: m.role, content: m.content })),
      user_input: text,
      image_base64_list: b64s.length ? b64s : undefined,
    });
    d.messages.push({ role: "assistant", content: r.reply });
    if (r.status === "ready") d.ready = true;
    touch();
  } catch (e) {
    if (pushed) d.messages.pop();  // 只回滚本次插入的消息
    toast(e.message, true);
  }
  $("chat-send").disabled = false;
  touch(); renderChat();
}
function onChatImage(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { S.chatImages.push(reader.result); toast("已附图，发送时一并传给 AI"); };
  reader.readAsDataURL(file);
}

/* ================= 资产页（角色/场景/道具） ================= */
const KIND_LABEL = { characters: "角色", scenes: "场景", props: "道具" };
function setAssetTab(k) {
  S.assetTab = k;
  document.querySelectorAll("#asset-seg .seg-item").forEach((el) =>
    el.classList.toggle("active", el.dataset.k === k));
  renderAssets();
}
function renderAssets() {
  const k = S.assetTab;
  const items = (S.cur.data.story || {})[k] || [];
  const grid = $("asset-grid");
  if (!items.length) {
    grid.innerHTML = `<div class="card pad" style="grid-column:1/-1;text-align:center;color:var(--muted);font-size:13.5px;">
      还没有${KIND_LABEL[k]}，先在「故事」页生成剧本</div>`;
    return;
  }
  grid.innerHTML = items.map((it, i) => `
    <div class="asset-card" onclick="openAssetSheet('${k}',${i})">
      <div class="asset-img">
        ${it.image_url ? `<img src="${it.image_url}" loading="lazy">`
          : `<div class="asset-empty">🖼<span>点击生成设定图</span></div>`}
      </div>
      <div class="asset-name"><b>${esc(it.name)}</b><span>${esc((it.description || "").slice(0, 22))}</span></div>
    </div>`).join("");
}
function openAssetSheet(kind, index) {
  const it = (S.cur.data.story || {})[kind]?.[index];
  if (!it) return;
  const isChar = kind === "characters";
  const refs = it.ref_images || [];
  openSheet(`
    <div class="sheet-title">${esc(it.name)} <span style="font-size:12px;color:var(--muted);font-weight:400;">· ${KIND_LABEL[kind]}设定</span></div>
    ${it.image_url ? `<img class="sheet-img-preview" src="${it.image_url}" onclick="showLightbox('${it.image_url}')">` : ""}
    <label class="field-label">参考图${isChar ? "（角色参考图/真人脸，最多 9 张）" : ""}</label>
    <div class="sheet-preview-row" id="ref-row">
      ${refs.map((u, j) => `<div style="position:relative"><img src="${u}" onclick="showLightbox('${u}')">
        <button class="img-del" style="width:20px;height:20px;font-size:10px;" onclick="delRef('${kind}',${index},${j})">✕</button></div>`).join("")}
      <button class="ref-add-btn" onclick="addRef('${kind}',${index})">＋<span>上传</span></button>
    </div>
    <label class="field-label">名称</label>
    <input id="as-name" value="${esc(it.name)}">
    <label class="field-label">设定描述</label>
    <textarea id="as-desc" rows="2">${esc(it.description || "")}</textarea>
    <label class="field-label">生图提示词</label>
    <textarea id="as-prompt" rows="5">${esc(it.image_prompt || "")}</textarea>
    <label class="field-label">AI 重写指令（可选，如"换成短发"）</label>
    <input id="as-feedback" placeholder="留空则仅规范化提示词">
    <div style="display:flex;gap:8px;margin-top:16px;">
      <button class="btn btn-ghost" style="flex:1;" onclick="aiRewrite('${kind}',${index})">✨ AI 重写</button>
      <button class="btn btn-primary" style="flex:1;" id="as-gen" onclick="genAssetImage('${kind}',${index})">🖼 生成设定图</button>
    </div>
    <button class="btn btn-ghost btn-block" onclick="saveAsset('${kind}',${index})">保存修改</button>
    ${it.image_url ? `<button class="btn btn-danger btn-block" onclick="delAssetImage('${kind}',${index})">删除当前设定图</button>` : ""}`);
}
function saveAsset(kind, index) {
  const it = (S.cur.data.story || {})[kind]?.[index];
  if (!it) return;
  it.name = $("as-name").value.trim() || it.name;
  it.description = $("as-desc").value.trim();
  it.image_prompt = $("as-prompt").value.trim();
  touch();
  renderAssets();
  closeSheet();
  toast("已保存");
}
async function genAssetImage(kind, index) {
  const it = (S.cur.data.story || {})[kind]?.[index];
  const btn = $("as-gen");
  if (!it || !btn) return;
  it.image_prompt = $("as-prompt").value.trim() || it.image_prompt;
  btn.classList.add("busy");
  btn.textContent = "生成中…";
  const meta = [];
  const urls = [];
  const isCharSheet = kind === "characters";
  for (const u of it.ref_images || []) {
    urls.push(u);
    meta.push({
      kind: isCharSheet ? "face" : "ref",
      name: it.name,
      // v14 融脸修复：写明这是"本人"照片，后端还会追加脸锁定指令
      description: isCharSheet
        ? `角色「${it.name}」的真人脸参考照片：照片中的人物就是这个角色的本人，生成图的面部必须与此照片高度一致`
        : "用户上传的参考图",
    });
  }
  try {
    const r = await api("/api/generate-image", {
      prompt: it.image_prompt,
      reference_urls: urls.length ? urls : undefined,
      reference_meta: meta.length ? meta : undefined,
      size: "2048x2048",
    });
    it.image_url = r.image_url;
    touch(); renderAssets(); openAssetSheet(kind, index);
    if (r.warnings) toast(r.warnings, true);
    else toast("设定图已生成");
  } catch (e) { toast(e.message, true); openAssetSheet(kind, index); }
}
async function aiRewrite(kind, index) {
  const st = S.cur.data.story;
  const it = st[kind]?.[index];
  if (!it) return;
  const feedback = ($("as-feedback").value || "").trim();
  showBusy("AI 正在重写提示词…", "结合画风圣经与角色锚点");
  try {
    const r = await api("/api/regenerate-prompt", {
      type: kind === "characters" ? "character" : kind === "scenes" ? "scene" : "prop",
      name: it.name, description: it.description,
      style_bible: st.style_bible || "",
      characters: (st.characters || []).map((c) => ({ name: c.name, image_prompt: c.image_prompt })),
      old_prompt: it.image_prompt, feedback: feedback || undefined,
    });
    it.image_prompt = r.image_prompt || it.image_prompt;
    hideBusy(); touch(); openAssetSheet(kind, index);
    toast("提示词已重写，可检查后生成");
  } catch (e) { hideBusy(); toast(e.message, true); }
}
function addRef(kind, index) { S.refTarget = { kind, index }; $("ref-file-input").click(); }
async function onRefImages(input) {
  // 注意：必须先把文件列表取出来再清 value——直接 input.value="" 会把已选文件一并清空，
  // 循环遍历时 files 已是空数组，上传静默失败、缩略图也不出现（v16 修复）
  const t = S.refTarget;
  S.refTarget = null;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!t || !files.length) return;
  const it = (S.cur.data.story || {})[t.kind]?.[t.index];
  if (!it) return;
  it.ref_images ||= [];
  for (const file of files) {
    if (it.ref_images.length >= 9) break;
    const dataUrl = await new Promise((res) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file);
    });
    try {
      const r = await api("/api/upload-image", { image_base64: dataUrl, filename: file.name });
      it.ref_images.push(r.image_url);
    } catch (e) { toast(e.message, true); break; }
  }
  touch(); openAssetSheet(t.kind, t.index); renderAssets();
}
function delRef(kind, index, j) {
  const it = (S.cur.data.story || {})[kind]?.[index];
  if (!it) return;
  it.ref_images.splice(j, 1);
  touch(); openAssetSheet(kind, index);
}
function delAssetImage(kind, index) {
  const it = (S.cur.data.story || {})[kind]?.[index];
  if (!it) return;
  it.image_url = null;
  touch(); renderAssets(); openAssetSheet(kind, index);
}

/* ================= 分镜页 ================= */
function board(id) { return S.cur.data.boards.find((b) => b.id === id); }
function healStaleVideo() {
  // 兜底自愈：手机浏览器休眠杀定时器后，"渲染中"可能永远停在原地。超时/无任务 ID 自动转失败并写明原因
  if (!S.cur) return;
  let healed = false;
  for (const b of S.cur.data.boards || []) {
    if (b.videoStatus !== "running") continue;
    if (!b.videoTaskId) {
      b.videoStatus = "failed";
      b.videoError = "任务没有提交成功（没有拿到任务 ID），请重试";
      healed = true;
    } else if (b.videoStartedAt && Date.now() - b.videoStartedAt > 360000) {
      b.videoStatus = "failed";
      b.videoError = "渲染超过 6 分钟未完成，已自动停止，请重试（若平台侧其实已完成，重试会重新生成）";
      stopPoll(b.id);
      healed = true;
    }
  }
  if (healed) touch();
}
function renderBoards() {
  healStaleVideo();
  const list = $("board-list");
  const boards = S.cur.data.boards;
  const landscape = S.cur.data.orientation === "landscape";
  document.querySelectorAll("#orient-seg .seg-item").forEach((el) =>
    el.classList.toggle("active", (el.dataset.k === "landscape") === landscape));
  if (!boards.length) {
    list.innerHTML = `<div class="card pad" style="text-align:center;color:var(--muted);font-size:13.5px;">
      还没有分镜：在「故事」页生成剧本，或点上方「➕ 新增分镜」手动添加</div>`;
    return;
  }
  const genAreaStyle = landscape ? "width:200px;height:150px;" : "width:150px;height:200px;";
  list.innerHTML = boards.map((b) => {
    const genImg = b.imageBusy ? `
      <div class="board-gen-area">
        <div class="gen-progress"><div class="gen-bar"><div class="gen-bar-inner" style="width:70%;"></div></div></div>
        <div class="gen-text">正在生成画面… 约 20–40 秒</div>
      </div>`
      : b.images.length ? `
      <div class="board-imgs">
        ${b.images.map((u, j) => `<div class="board-img-item">
          <img src="${u}" loading="lazy" onclick="showLightbox('${u}')">
          <button class="img-del" onclick="delBoardImage('${b.id}',${j})">✕</button>
        </div>`).join("")}
        <div class="board-img-item" onclick="genBoardImage('${b.id}')">
          <div class="board-gen-area" style="${genAreaStyle}">＋<span style="font-size:11px;">再生成一张</span></div>
        </div>
      </div>`
      : `<div class="board-gen-area" style="${genAreaStyle}" onclick="genBoardImage('${b.id}')">
          🖼<span>点击生成分镜画面</span><span style="font-size:11px;">约 20–40 秒 · 自动携带角色/场景参考</span>
        </div>`;
    const videoPart = b.videoUrl ? `
      <div class="board-video">
        <video src="${b.videoUrl}" controls playsinline preload="metadata" onerror="videoLoadErr('${b.id}')"></video>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-primary" style="flex:1;" onclick="saveVideoToPhone('${b.id}')">⬇️ 保存到手机</button>
          <button class="btn btn-ghost" onclick="delBoardVideo('${b.id}')">🗑 删除</button>
        </div>
      </div>`
      : b.videoStatus === "running" ? `
      <div class="board-video"><div class="board-gen-area" style="height:auto;padding:16px;">
        <div class="gen-progress"><div class="gen-bar"><div class="gen-bar-inner" id="vp-${b.id}" style="width:8%;"></div></div></div>
        <div class="gen-text" id="vt-${b.id}">云端渲染中…（约 1–3 分钟）</div>
      </div></div>`
      : b.videoStatus === "failed" ? `
      <div class="board-video"><div class="board-gen-area" style="height:auto;padding:14px;color:var(--danger);">
        生成失败，请重试${b.videoError ? `<div style="font-size:12px;margin-top:6px;opacity:.85;">原因：${esc(b.videoError)}</div>` : ""}
      </div></div>` : "";
    const hasDiag = !!(b.topView || b.trajView);
    const canVideo = b.images.length > 0 && b.videoStatus !== "running";
    return `
    <div class="board-card" data-bid="${b.id}">
      <div class="board-head">
        <div class="drag-handle" title="按住拖动排序">⠿</div>
        <div class="shot-badge">${b.shot_number}</div>
        <div class="board-desc">${esc(b.description)}
          ${b.dialogue ? `<div class="board-dialogue">${esc(b.dialogue)}</div>` : ""}
        </div>
        <div class="dur-chip">${b.duration}s</div>
      </div>
      <div class="board-media">${genImg}</div>
      ${videoPart}
      <div class="board-actions">
        <button class="btn btn-ghost" onclick="genBoardImage('${b.id}')">🖼 生图</button>
        <button class="btn btn-ghost" onclick="openDiagramSheet('${b.id}')">🗺 调度图${hasDiag ? " ✅" : ""}</button>
        <button class="btn btn-ghost" onclick="openBoardSheet('${b.id}')">✏️ 提示词</button>
        <button class="btn btn-primary" ${canVideo ? "" : "disabled"} onclick="genBoardVideo('${b.id}')">🎬 视频</button>
        <button class="btn btn-ghost btn-act-sm" onclick="moveBoard('${b.id}',-1)" title="上移">▲</button>
        <button class="btn btn-ghost btn-act-sm" onclick="moveBoard('${b.id}',1)" title="下移">▼</button>
        <button class="btn btn-ghost btn-act-sm" onclick="addBoardAfter('${b.id}')" title="在此镜头后插入新分镜">➕</button>
        <button class="btn btn-ghost btn-act-sm board-del" onclick="delBoard('${b.id}')" title="删除此分镜">🗑</button>
      </div>
    </div>`;
  }).join("");
  bindBoardDnD();
}
/* ---------- 分镜管理：新增 / 删除 / 拖拽排序 ---------- */
function renumberBoards() {
  (S.cur?.data.boards || []).forEach((b, i) => { b.shot_number = i + 1; });
}
function addBoardAfter(bid) {
  if (!S.cur) return;
  const boards = S.cur.data.boards;
  const nb = {
    id: "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    shot_number: boards.length + 1,
    description: "（新分镜 · 点「✏️ 提示词」编辑描述与提示词）",
    dialogue: "", duration: 3, image_prompt: "", video_prompt: "",
    images: [], videoUrl: null, videoTaskId: null, videoStatus: null, videoError: null,
  };
  const idx = bid ? boards.findIndex((b) => b.id === bid) : boards.length - 1;
  boards.splice(idx + 1, 0, nb);
  renumberBoards();
  touch(); renderBoards();
  $("board-list").querySelector(`[data-bid="${nb.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  toast(`已新增第 ${nb.shot_number} 个分镜`);
}
function delBoard(bid) {
  const boards = S.cur?.data.boards || [];
  const idx = boards.findIndex((b) => b.id === bid);
  if (idx < 0) return;
  const b = boards[idx];
  if (!confirm(`确定删除分镜 ${b.shot_number}「${(b.description || "").slice(0, 20)}」吗？\n删除后不可恢复（已生成的图片视频文件仍保留）。`)) return;
  if (b.videoStatus === "running") stopPoll(b.id);
  boards.splice(idx, 1);
  renumberBoards();
  touch(); renderBoards();
  toast("分镜已删除");
}
let bDrag = null;      // {bid, card, active, startY, mode: "touch"|"mouse", tid}
let pressTimer = null; // 长按计时器（长按卡片空白处也可拖动）
function bindBoardDnD() {
  const list = $("board-list");
  if (!list) return;
  // 触屏：用原生 touch 事件（兼容性最好，绕开各家浏览器 pointer 事件差异），事件委托在 list 上
  if (!list._dndBound) {
    list._dndBound = true;
    list.addEventListener("touchstart", listTouchStart, { passive: false });
    // 鼠标（电脑调试用）：把手 pointerdown 直接拖
    list.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || bDrag) return;
      const handle = e.target.closest(".drag-handle");
      if (!handle) return;
      const card = handle.closest(".board-card");
      if (!card || !S.cur || S.cur.data.boards.length < 2) return;
      e.preventDefault();
      beginDrag(card, "m" + e.pointerId, e.clientY, "mouse");
    });
  }
}
/* 触屏入口：
   - 按住 ⠿ 把手 → 立即进入拖拽
   - 长按卡片空白处 0.45s → 进入拖拽（按钮/图片/视频除外；启动前移动>10px 视为滚动并取消） */
function listTouchStart(e) {
  if (bDrag) return;
  if (!S.cur || S.cur.data.boards.length < 2) return;
  const touch = e.touches && e.touches[0];
  if (!touch) return;
  const card = e.target.closest(".board-card");
  if (!card) return;
  const handle = e.target.closest(".drag-handle");
  if (handle) {
    e.preventDefault();
    beginDrag(card, "t" + touch.identifier, touch.clientY, "touch");
    try { navigator.vibrate && navigator.vibrate(15); } catch (_) {}
    return;
  }
  if (e.target.closest("button,video,img,input,textarea,select,a,.board-video")) return;
  const x0 = touch.clientX, y0 = touch.clientY;
  const cancel = () => {
    clearTimeout(pressTimer); pressTimer = null;
    document.removeEventListener("touchmove", pressMove);
    document.removeEventListener("touchend", cancel);
    document.removeEventListener("touchcancel", cancel);
  };
  const pressMove = (ev) => {
    const t = ev.touches && ev.touches[0];
    if (t && (Math.abs(t.clientY - y0) > 10 || Math.abs(t.clientX - x0) > 10)) cancel();
  };
  clearTimeout(pressTimer);
  document.addEventListener("touchmove", pressMove, { passive: true });
  document.addEventListener("touchend", cancel);
  document.addEventListener("touchcancel", cancel);
  pressTimer = setTimeout(() => {
    clearTimeout(pressTimer); pressTimer = null;
    document.removeEventListener("touchmove", pressMove);
    document.removeEventListener("touchend", cancel);
    document.removeEventListener("touchcancel", cancel);
    if (bDrag) return;
    beginDrag(card, "t" + touch.identifier, y0, "touch");
    try { navigator.vibrate && navigator.vibrate(20); } catch (_) {}
  }, 450);
}
function beginDrag(card, tid, startY, mode) {
  bDrag = { bid: card.dataset.bid, card, active: false, startY, mode, tid };
  // 不能用 setPointerCapture——卡片在 DOM 里移动位置会导致捕获被释放、后续 move 收不到。
  // 统一挂 document 级监听。
  if (mode === "touch") {
    document.addEventListener("touchmove", dragTouchMove, { passive: false });
    document.addEventListener("touchend", dragTouchEnd);
    document.addEventListener("touchcancel", dragTouchEnd);
  } else {
    document.addEventListener("pointermove", dragPointerMove, { passive: false });
    document.addEventListener("pointerup", dragPointerEnd);
    document.addEventListener("pointercancel", dragPointerEnd);
  }
}
function applyDragPosition(clientY) {
  if (!bDrag.active) {
    if (Math.abs(clientY - bDrag.startY) < 10) return;
    bDrag.active = true;
    bDrag.card.classList.add("dragging");
    document.body.classList.add("board-drag-noselect");
  }
  const cards = [...$("board-list").querySelectorAll(".board-card:not(.dragging)")];
  const after = cards.filter((c) => {
    const r = c.getBoundingClientRect();
    return clientY > r.top + r.height / 2;
  }).pop();
  if (after) {
    if (after.nextElementSibling !== bDrag.card) after.after(bDrag.card);
  } else {
    $("board-list").prepend(bDrag.card);
  }
  // 拖到视口上下边缘时自动滚动（滚动容器是 #studio-body，不是 window）
  const sc = document.getElementById("studio-body");
  const vh = window.innerHeight;
  if (sc && clientY < 90) sc.scrollTop -= 16;
  else if (sc && clientY > vh - 90) sc.scrollTop += 16;
}
function dragTouchMove(e) {
  if (!bDrag || bDrag.mode !== "touch") return;
  const t = [...(e.touches || [])].find((x) => "t" + x.identifier === bDrag.tid) || (e.touches && e.touches[0]);
  if (!t) return;
  e.preventDefault(); // 拖拽中禁止页面滚动
  applyDragPosition(t.clientY);
}
function dragTouchEnd(e) {
  if (!bDrag || bDrag.mode !== "touch") return;
  document.removeEventListener("touchmove", dragTouchMove);
  document.removeEventListener("touchend", dragTouchEnd);
  document.removeEventListener("touchcancel", dragTouchEnd);
  finishDrag();
}
function dragPointerMove(e) {
  if (!bDrag || bDrag.mode !== "mouse" || bDrag.tid !== "m" + e.pointerId) return;
  applyDragPosition(e.clientY);
}
function dragPointerEnd(e) {
  if (!bDrag || bDrag.mode !== "mouse") return;
  document.removeEventListener("pointermove", dragPointerMove);
  document.removeEventListener("pointerup", dragPointerEnd);
  document.removeEventListener("pointercancel", dragPointerEnd);
  finishDrag();
}
function finishDrag() {
  if (!bDrag) return;
  const { card, active } = bDrag;
  bDrag = null;
  if (!active) return;
  card.classList.remove("dragging");
  document.body.classList.remove("board-drag-noselect");
  // 按新 DOM 顺序重排数据并重新编号
  const boards = S.cur.data.boards;
  const order = [...$("board-list").querySelectorAll(".board-card")].map((c) => c.dataset.bid);
  boards.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  renumberBoards();
  touch(); renderBoards();
}
/* ▲▼ 微调按钮：不依赖手势，任何设备都能保证排序 */
function moveBoard(bid, dir) {
  const boards = S.cur?.data.boards || [];
  const i = boards.findIndex((b) => b.id === bid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= boards.length) return;
  [boards[i], boards[j]] = [boards[j], boards[i]];
  renumberBoards();
  touch(); renderBoards();
  $("board-list").querySelector(`[data-bid="${bid}"]`)?.scrollIntoView({ block: "nearest" });
}
// 拖拽进行中：禁止系统长按菜单（touchmove 滚动已在 dragTouchMove 里 preventDefault）
document.addEventListener("contextmenu", (e) => { if (bDrag && bDrag.active) e.preventDefault(); });
function delBoardImage(bid, j) {
  const b = board(bid);
  if (!b) return;
  b.images.splice(j, 1);
  touch(); renderBoards();
}
function openBoardSheet(bid) {
  const b = board(bid);
  if (!b) return;
  openSheet(`
    <div class="sheet-title">镜头 ${b.shot_number} · 提示词</div>
    <div class="sheet-sub">改完记得保存；AI 重写会保留你写死的细节</div>
    <label class="field-label">剧情作用</label>
    <textarea id="bd-desc" rows="2">${esc(b.description)}</textarea>
    <label class="field-label">台词 / 旁白（没有留空）</label>
    <textarea id="bd-dialogue" rows="2">${esc(b.dialogue || "")}</textarea>
    <label class="field-label">时长（2–5 秒）</label>
    <input id="bd-dur" type="number" min="2" max="5" value="${b.duration}">
    <label class="field-label">生图提示词</label>
    <textarea id="bd-imgp" rows="6">${esc(b.image_prompt)}</textarea>
    <label class="field-label">视频提示词</label>
    <textarea id="bd-vidp" rows="4">${esc(b.video_prompt || "")}</textarea>
    <label class="field-label">AI 重写指令（可选）</label>
    <input id="bd-feedback" placeholder="如：镜头缓缓推近，情绪更压抑">
    <div style="display:flex;gap:8px;margin-top:16px;">
      <button class="btn btn-ghost" style="flex:1;" onclick="aiRewriteBoard('${b.id}')">✨ AI 重写</button>
      <button class="btn btn-primary" style="flex:1;" onclick="saveBoard('${b.id}')">保存</button>
    </div>`);
}
function saveBoard(bid) {
  const b = board(bid);
  if (!b) return;
  b.description = $("bd-desc").value.trim();
  b.dialogue = $("bd-dialogue").value.trim();
  b.duration = Math.min(5, Math.max(2, parseInt($("bd-dur").value) || 3));
  b.image_prompt = $("bd-imgp").value.trim();
  b.video_prompt = $("bd-vidp").value.trim();
  touch(); closeSheet(); renderBoards(); toast("已保存");
}
async function aiRewriteBoard(bid) {
  const b = board(bid);
  const st = S.cur.data.story;
  if (!b) return;
  showBusy("AI 正在重写提示词…", "分镜提示词 + 视频提示词一起更新");
  try {
    const r = await api("/api/regenerate-prompt", {
      type: "storyboard",
      name: "镜头 " + b.shot_number,
      description: b.description, dialogue: b.dialogue, duration: b.duration,
      style_bible: (st && st.style_bible) || "",
      synopsis: (st && st.synopsis) || "",
      characters: ((st && st.characters) || []).map((c) => ({ name: c.name, image_prompt: c.image_prompt })),
      old_prompt: b.image_prompt, feedback: ($("bd-feedback").value || "").trim() || undefined,
    });
    b.image_prompt = r.image_prompt || b.image_prompt;
    if (r.video_prompt) b.video_prompt = r.video_prompt;
    hideBusy(); touch(); openBoardSheet(bid);
    toast("提示词已重写");
  } catch (e) { hideBusy(); toast(e.message, true); }
}
async function genBoardImage(bid) {
  const b = board(bid);
  if (!b || b.imageBusy) return;
  b.imageBusy = true;
  renderBoards();
  const landscape = S.cur.data.orientation === "landscape";
  const urls = [], meta = [];
  // 调度图是导演定稿，永远排最前（后端对 kind=diagram 强制保留不筛选）
  const diagUrl = b.trajView || b.topView;
  const diagPlot = b.trajViewPlot || b.topViewPlot;
  if (diagUrl) {
    urls.push(diagUrl);
    meta.push({ kind: "diagram", name: "调度图", description: "本图是导演定稿的俯视调度图纸：正上方俯视平面图，人偶棋子图标＝人物（标签为人名），「机位」符号＝摄影机位置，虚线箭头＝运动路线。人物位置/走位/机位以本图为准。" });
  }
  const st = S.cur.data.story || {};
  for (const c of st.characters || []) if (c.image_url) {
    urls.push(c.image_url);
    meta.push({ kind: "character", name: c.name, description: `官方设定图（该角色服装/发型/造型的权威基准，画面中角色必须与此图着装一致）：${c.image_prompt || c.description || ""}` });
    // v14 融脸修复：把用户上传的真人脸照片也带上（设定图经过 AI 转绘会丢 likeness，
    // 真人照片才是"本人"的最高基准；后端按 kind=face 注入脸锁定指令）
    for (const u of c.ref_images || []) {
      if (urls.length >= 9) break;
      urls.push(u);
      meta.push({ kind: "face", name: c.name, description: `角色「${c.name}」的真人脸参考照片，画面中该角色的面部必须与照片高度一致` });
    }
  }
  for (const sc of st.scenes || []) if (sc.image_url) {
    urls.push(sc.image_url);
    meta.push({ kind: "scene", name: sc.name, description: sc.image_prompt || sc.description || "" });
  }
  const refs = { reference_urls: urls.slice(0, 9), reference_meta: meta.slice(0, 9) };
  try {
    const r = await api("/api/generate-image", {
      prompt: b.image_prompt, ...refs,
      size: landscape ? "1920x1080" : "1080x1920",
      plot_data: diagPlot || undefined,
    });
    b.images.push(r.image_url);
    if (r.warnings) toast(r.warnings, true);
  } catch (e) { toast(e.message, true); }
  b.imageBusy = false;
  touch(); renderBoards();
}
async function genBoardVideo(bid) {
  const b = board(bid);
  if (!b || b.videoStatus === "running") return;
  if (!b.images.length) return toast("先生成分镜图", true);
  if (!b.video_prompt) return toast("缺少视频提示词，先在「提示词」里补全", true);
  b.videoStatus = "running";
  b.videoError = null;
  b.videoUrl = null; // 重新生成：清掉上一次的成片，否则轮询被旧结果短路、界面也一直显示旧视频
  b.videoStartedAt = Date.now();
  renderBoards();
  const st = S.cur.data.story || {};
  const landscape = S.cur.data.orientation === "landscape";
  const urls = [b.images[0]];
  const diagUrl = b.trajView || b.topView;
  if (diagUrl && urls.length < 9) urls.push(diagUrl);
  for (const c of st.characters || []) if (c.image_url && urls.length < 9) urls.push(c.image_url);
  for (const sc of st.scenes || []) if (sc.image_url && urls.length < 9) urls.push(c.image_url);
  try {
    // 按所选模型自动适配提交模式：首尾帧工作流以分镜图为首帧+尾帧（起点=终点，画面从图出发再回到图）；
    // 其余为多图参考模式（分镜图+调度图+角色/场景图一起作参考）
    const wf = getVideoWorkflow();
    const isFirstLast = wf === "minimax_h3_lightx2v";
    const r = await api("/api/generate-video", {
      prompt: b.video_prompt,
      image_urls: urls,
      duration: b.duration,
      resolution: "768p",
      frame_mode: isFirstLast ? "first_last" : "reference",
      first_frame_url: isFirstLast ? b.images[0] : undefined,
      last_frame_url: isFirstLast ? b.images[0] : undefined,
      image_aspect: landscape ? 16 / 9 : 9 / 16,
      workflow_id: wf || undefined,
      plot_data: (b.trajViewPlot || b.topViewPlot) || undefined,
    });
    b.videoTaskId = r.task_id;
    touch(); saveNow(); // 立刻落盘任务 ID，防止刷新/服务重启后丢任务卡在"渲染中"
    if (r.warning) toast(r.warning, true);
    startPoll(bid);
  } catch (e) {
    b.videoStatus = "failed";
    b.videoError = e.message; // 失败原因写进卡片，不再只靠一闪而过的 toast
    toast(e.message, true);
  }
  touch(); renderBoards();
}
function startPoll(bid) {
  stopPoll(bid);
  S.pollers[bid] = setInterval(() => pollOnce(bid), 4000);
  pollOnce(bid);
}
function stopPoll(bid) {
  if (S.pollers[bid]) { clearInterval(S.pollers[bid]); delete S.pollers[bid]; }
}
function resumePollers() {
  let recovered = false;
  for (const b of S.cur.data.boards || []) {
    // 状态是"渲染中"却没有任务 ID → 永远轮不到结果，标记失败让用户可重试
    if (b.videoStatus === "running" && !b.videoTaskId) {
      b.videoStatus = "failed";
      b.videoError = "任务没有提交成功（没有拿到任务 ID），请重试";
      recovered = true;
      continue;
    }
    if (b.videoTaskId && !b.videoUrl && b.videoStatus === "running") startPoll(b.id);
  }
  if (recovered) { touch(); renderBoards(); }
}
async function pollOnce(bid) {
  const b = board(bid);
  if (!b || !b.videoTaskId || b.videoUrl) return stopPoll(bid);
  let r;
  try { r = await api(`/api/video-status/${b.videoTaskId}`); }
  catch (_) { return; } // 网络抖动下一轮继续
  const status = (r.status || "").toUpperCase();
  if (["SUCCESS", "COMPLETED", "SUCCEEDED"].includes(status) && r.video_url) {
    try {
      const sv = await api("/api/save-video", { task_id: b.videoTaskId });
      b.videoUrl = sv.video_url;
      b.videoStatus = "done";
      toast(`🎬 镜头 ${b.shot_number} 成片已保存`);
    } catch (e) {
      b.videoUrl = r.video_url; // 兜底：直接用云端临时链接
      b.videoStatus = "done";
      toast(e.message + "（已用临时链接展示，建议尽快保存）", true);
    }
    stopPoll(bid);
    touch(); if (S.tab === "boards") renderBoards();
  } else if (["FAILED", "ERROR", "CANCELLED", "TIMEOUT"].includes(status)) {
    b.videoStatus = "failed";
    stopPoll(bid);
    toast(`镜头 ${b.shot_number} 视频生成失败`, true);
    touch(); if (S.tab === "boards") renderBoards();
  } else if (S.tab === "boards") {
    const elapsed = (Date.now() - (b.videoStartedAt || Date.now())) / 1000;
    // 活跃轮询下也做超时兜底：平台任务挂死时不再无限"渲染中"
    if (elapsed > 360) {
      b.videoStatus = "failed";
      b.videoError = "渲染超过 6 分钟未完成，已自动停止，请重试";
      stopPoll(bid);
      toast("渲染超时，已停止，请重试", true);
      touch(); renderBoards();
      return;
    }
    // 估算进度：经验值约 100 秒渲染完
    const pct = Math.min(95, Math.round((elapsed / 100) * 100) + 5);
    const bar = $("vp-" + bid), txt = $("vt-" + bid);
    if (bar) bar.style.width = pct + "%";
    if (txt) txt.textContent = `云端渲染中… ${pct}%（约 1–3 分钟）`;
  }
}

/* ================= 设置页 ================= */
function getVideoWorkflow() {
  return localStorage.getItem("wb_video_workflow") || "";
}
function saveVideoWorkflow() {
  localStorage.setItem("wb_video_workflow", $("set-workflow").value);
  const label = $("set-workflow").selectedOptions[0].textContent;
  toast("视频模型已切换：" + label);
}
function renderSettings() {
  $("set-workflow").value = getVideoWorkflow();
}
async function renderApiKeys() {
  const el = $("settings-masked");
  if (!el) return;
  try {
    const r = await api("/api/settings");
    const cust = r.custom || {};
    const mk = (k, v, isCustom) => {
      if (!v) return `<div><b>${k}</b>：未配置</div>`;
      const tag = isCustom ? " · <span style='color:#d97706;'>自定义</span>"
                           : " · <span style='color:#64748b;'>全局</span>";
      return `<div><b>${k}</b>：${esc(v)}${tag}</div>`;
    };
    el.innerHTML = [
      mk("DeepSeek", r.deepseek_api_key, cust.deepseek),
      mk("方舟 ARK", r.ark_api_key, cust.ark),
      mk("AutoDL 令牌", r.autodl_token, cust.autodl),
    ].join("");
  } catch (_) {}
}
async function saveSettings() {
  const body = {};
  const map = { "set-deepseek": "deepseek_api_key", "set-ark": "ark_api_key", "set-autodl": "autodl_token" };
  for (const [id, key] of Object.entries(map)) {
    const v = $(id).value.trim();
    if (v) body[key] = v;
  }
  if (!Object.keys(body).length) return toast("没有填写新密钥");
  showBusy("保存密钥…");
  try {
    await api("/api/settings", body);
    for (const id of Object.keys(map)) $(id).value = "";
    hideBusy();
    toast("密钥已保存，立即生效");
    renderApiKeys();
  } catch (e) { hideBusy(); toast(e.message, true); }
}

/* ================= API 设置页（首页 / 工作台均可进入的独立页） ================= */
let apiFrom = null; // 记录从哪个屏幕进入，返回时还原
function showApiScreen(from) {
  // 来源必须显式传入（home/studio）。不能用 S.cur 猜：回首页后 S.cur 仍保留，
  // 会导致从首页打开、关闭后却落到详情页。
  apiFrom = (from === "studio" || from === "home") ? from : "home";
  $("home-screen").classList.add("hidden");
  $("studio-screen").classList.add("hidden");
  $("api-screen").classList.remove("hidden");
  $("set-deepseek").value = ""; $("set-ark").value = ""; $("set-autodl").value = "";
  renderApiKeys();
}
function closeApiScreen() {
  $("api-screen").classList.add("hidden");
  $(apiFrom === "studio" ? "studio-screen" : "home-screen").classList.remove("hidden");
}
async function deleteCurrentProject() {
  if (!S.cur) return;
  if (!confirm(`确定删除项目「${S.cur.name}」？数据删除后无法恢复。`)) return;
  try {
    await api(`/api/projects/${S.cur.id}`, undefined, "DELETE");
    toast("已删除");
    backHome();
  } catch (e) { toast(e.message, true); }
}

/* ================= 抽屉 / 灯箱 ================= */
function openSheet(html) {
  $("sheet-body").innerHTML = html;
  $("sheet-mask").classList.remove("hidden");
  $("sheet").classList.remove("hidden");
}
function closeSheet(e) {
  if (e && e.target && e.target.id !== "sheet-mask") return;
  $("sheet-mask").classList.add("hidden");
  $("sheet").classList.add("hidden");
}
function showLightbox(url) {
  $("lightbox-img").src = url;
  $("lightbox").classList.remove("hidden");
}
function closeLightbox() {
  $("lightbox").classList.add("hidden");
  $("lightbox-img").src = "";
}

/* ================= 画幅方向 ================= */
function setOrientation(o) {
  if (!S.cur) return;
  if (S.cur.data.orientation === o) return;
  S.cur.data.orientation = o;
  touch(); renderBoards();
  toast(o === "landscape" ? "已切换横屏：新生成画面为 1920×1080" : "已切换竖屏：新生成画面为 1080×1920");
}

/* ================= 调度图 ================= */
const DIAGRAM_PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080", "#f032e6", "#9a6324", "#000075", "#800000"];
const DIAGRAM_KINDS = { topview: "俯视调度图", trajectory: "轨迹调度图" };
function diagKey(kind, suffix) { return (kind === "trajectory" ? "traj" : "top") + "View" + suffix; }
function openDiagramSheet(bid, kind) {
  const b = board(bid);
  if (!b) return;
  kind = kind || "topview";
  const url = b[diagKey(kind, "")];
  const plot = b[diagKey(kind, "Plot")];
  openSheet(`
    <div class="sheet-title">镜头 ${b.shot_number} · 调度图</div>
    <div class="sheet-sub">AI 把你的口述解析成走位坐标，程序绘制成俯视图纸（不是 AI 生图，永远精确）；生成画面/视频时自动作为导演定稿参考</div>
    <div class="seg">
      <button class="seg-item ${kind === "topview" ? "active" : ""}" onclick="openDiagramSheet('${bid}','topview')">俯视图 · 站位机位</button>
      <button class="seg-item ${kind === "trajectory" ? "active" : ""}" onclick="openDiagramSheet('${bid}','trajectory')">轨迹图 · 运动路线</button>
    </div>
    ${url ? `<div class="diag-thumb"><img src="${url}" loading="lazy" onclick="showLightbox(this.src)"></div>` : ""}
    <label class="field-label">导演口述（站位 / 走位 / 机位，最高优先级逐条落实）</label>
    <textarea id="dg-desc" rows="4" placeholder="例如：小帅站门口左侧，小美坐桌边；机位在窗户一侧拍全景；小帅缓缓走向镜头">${esc(b[diagKey(kind, "Desc")] || "")}</textarea>
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button class="btn btn-primary" style="flex:1;" onclick="genDiagram('${bid}','${kind}')">${url ? "🔄 重生图纸" : "✨ 生成图纸"}</button>
      <button class="btn btn-ghost" style="flex:1;" ${plot ? `onclick="openDirector3D('${bid}','${kind}')"` : "disabled"}>🎬 3D 导演台</button>
      ${url ? `<button class="btn btn-danger" onclick="delDiagram('${bid}','${kind}')">🗑</button>` : ""}
    </div>
    ${plot
      ? `<div class="sheet-hint">💡 3D 导演台里单指拖人物/机位/轨迹红点，松手自动重绘图纸并同步坐标</div>`
      : `<div class="sheet-hint">💡 「3D 导演台」需要先点「生成图纸」——AI 解析口述得到站位坐标后，才能在 3D 场景里拖拽调走位</div>`}
  `);
}
async function genDiagram(bid, kind) {
  const b = board(bid);
  if (!b) return;
  const desc = (($("dg-desc") || {}).value || "").trim();
  b[diagKey(kind, "Desc")] = desc;
  const st = S.cur.data.story || {};
  showBusy("正在绘制调度图…", "AI 解析口述 → 坐标 → 程序绘制，约 10–20 秒");
  try {
    const r = await api("/api/render-diagram", {
      kind,
      description: b.description || "",
      dialogue: b.dialogue || "",
      duration: b.duration || 3,
      video_prompt: b.video_prompt || "",
      characters: (st.characters || []).map((c) => ({ name: c.name || "", description: c.description || "" })),
      feedback: desc || undefined,
      base_plot: kind === "trajectory" && b.topViewPlot ? b.topViewPlot : undefined,
    });
    b[diagKey(kind, "")] = r.image_url;
    b[diagKey(kind, "Plot")] = r.plot || null;
    b[diagKey(kind, "CamSummary")] = r.cam_summary || "";
    touch(); hideBusy(); closeSheet(); renderBoards();
    toast(r.source === "template"
      ? "AI 解析口述失败，已按默认布局绘制——修改口述后点「重生」重试"
      : "调度图完成！生成画面时会作为导演定稿参考");
  } catch (e) { hideBusy(); toast(e.message, true); }
}
function delDiagram(bid, kind) {
  const b = board(bid);
  if (!b) return;
  if (!confirm("确定删除这张调度图？（口述会保留）")) return;
  b[diagKey(kind, "")] = null;
  b[diagKey(kind, "Plot")] = null;
  touch(); closeSheet(); renderBoards(); toast("已删除");
}

/* ================= 3D 导演台 ================= */
function openDirector3D(bid, kind) {
  const b = board(bid);
  if (!b) return;
  kind = kind || "topview";
  const plot = b[diagKey(kind, "Plot")];
  if (!plot) return toast("这个分镜还没有调度图坐标，先生成图纸", true);
  if (!window.Director3D) return toast("3D 模块加载中，请稍候 2 秒再试", true);
  S.dir3d = { bid, kind };
  $("dir3d-title").textContent = `🎬 3D 导演台 · 镜头 ${b.shot_number} · ${DIAGRAM_KINDS[kind]}`;
  closeSheet();
  $("dir3d-overlay").classList.remove("hidden");
  mountDirector(bid, kind);
}
function mountDirector(bid, kind) {
  const b = board(bid);
  if (!b || !window.Director3D) return;
  const plot = b[diagKey(kind, "Plot")];
  if (!plot) return closeDirector3D();
  window.Director3D.open(bid + ":" + kind, $("dir3d-container"), plot, DIAGRAM_PALETTE,
    (plotCopy) => dir3dCommit(bid, kind, plotCopy));
}
async function dir3dCommit(bid, kind, plotCopy) {
  try {
    const r = await api("/api/rerender-diagram", { plot: plotCopy, kind });
    const b = board(bid);
    if (!b) return;
    b[diagKey(kind, "")] = r.image_url;
    b[diagKey(kind, "Plot")] = r.plot;
    b[diagKey(kind, "CamSummary")] = r.cam_summary || "";
    touch();
    mountDirector(bid, kind);  // 新坐标重建 3D 场景
    toast("图纸已按拖拽结果重绘，坐标已同步");
  } catch (e) {
    toast("重绘失败：" + e.message + "（原坐标未改动，可重试）", true);
  }
}
function closeDirector3D() {
  window.Director3D && window.Director3D.closeAll();
  $("dir3d-overlay").classList.add("hidden");
  // 退出后关闭调度图抽屉，直接回到分镜生图页
  $("sheet-mask").classList.add("hidden");
  $("sheet").classList.add("hidden");
  S.dir3d = null;
}

/* ================= 视频保存到手机 ================= */
async function delBoardVideo(bid) {
  const b = board(bid);
  if (!b || !b.videoUrl) return;
  if (!confirm(`确定删除镜头 ${b.shot_number} 的视频吗？删除后不可恢复（建议先保存到手机）`)) return;
  const name = b.videoUrl.split("?")[0].split("/").pop();
  // 先清镜头引用（立即生效），再静默清理服务器文件
  b.videoUrl = null; b.videoStatus = null; b.videoTaskId = null; b.videoError = null; b.videoStartedAt = null;
  touch(); renderBoards();
  toast("已删除");
  try { await api(`/api/videos/${encodeURIComponent(name)}`, undefined, "DELETE"); } catch (_) {}
}
function videoLoadErr(bid) {
  // <video> 加载失败：文件不存在/过期（如服务器数据被重置），转成失败态给出明确提示与重试入口
  const b = board(bid);
  if (!b || !b.videoUrl) return;
  b.videoStatus = "failed";
  b.videoError = "视频文件不存在或已失效（可能已被删除或服务器数据被重置），请重新生成视频";
  touch(); renderBoards();
}
async function saveVideoToPhone(bid) {
  const b = board(bid);
  if (!b || !b.videoUrl) return;
  const name = `镜头${b.shot_number}_${Date.now()}.mp4`;
  toast("正在准备下载…");
  let ok = false;
  try {
    const resp = await fetch(b.videoUrl);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    ok = true;
  } catch (_) { /* 跨域临时链接或浏览器拦截直接下载 */ }
  if (ok) {
    toast("已触发下载：查看系统通知栏或浏览器的「下载」；没找到就再点一次，会换一种保存方式");
  } else {
    showVideoSaveSheet(b, name);
  }
}
function showVideoSaveSheet(b, name) {
  openSheet(`
    <div class="sheet-title">保存镜头 ${b.shot_number} 的视频</div>
    <div class="sheet-sub">浏览器拦截了直接下载，用下面任一方式保存</div>
    <video src="${b.videoUrl}" controls playsinline preload="metadata" style="width:100%;border-radius:12px;background:#000;aspect-ratio:16/9;"></video>
    <a class="btn btn-primary btn-block" style="display:block;text-align:center;margin-top:12px;" href="${b.videoUrl}" download="${name}" target="_blank" rel="noopener">⬇️ 再次尝试下载</a>
    <div class="sheet-hint">📱 仍不行时：长按上面的视频画面 → 选「保存视频 / 下载」；或先点按钮在新页面打开，再长按视频保存</div>
  `);
}

/* ================= 启动 ================= */
window.addEventListener("load", async () => {
  // 未配置口令的服务器直接放行；配置了口令且本地没存对 → 登录页
  try {
    const ping = await fetch("/api/projects", { headers: { "x-access-code": S.code } });
    if (ping.status === 401) { showLogin(); return; }
  } catch (_) { toast("无法连接服务器，请检查网络", true); return; }
  try {
    await loadHome();
    showZoneBadge();
    $("home-screen").classList.remove("hidden");
  } catch (e) { toast(e.message, true); }
});
