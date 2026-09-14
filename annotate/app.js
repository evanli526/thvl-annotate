
"use strict";
/* ---------------- 标签元数据（与 taxonomy v3 一致） ---------------- */
const DOMAINS = {
  A: {name: "身体伤害与危险", color: "var(--A)"},
  B: {name: "性内容与性侵扰", color: "var(--B)"},
  C: {name: "侮辱与身份歧视", color: "var(--C)"},
  D: {name: "成瘾相关风险", color: "var(--D)"},
  E: {name: "财产侵害",     color: "var(--E)"},
  F: {name: "信息与隐私侵害", color: "var(--F)"},
};
const LABELS = [
  ["A1","暴力攻击"],["A2","自伤与自杀"],["A3","危险行为与事故"],["A4","血腥与重创画面"],
  ["B1","性化展示与露骨表达"],["B2","性骚扰与性侵害"],
  ["C1","人身侮辱与恐吓"],["C2","身份仇恨与歧视"],
  ["D1","物质滥用"],["D2","赌博行为与诱导"],
  ["E1","盗抢与财物毁损"],["E2","欺诈取财"],
  ["F1","有害虚假信息"],["F2","隐私侵犯"],
];
const LABEL_NAME = Object.fromEntries(LABELS);
const LABEL_COLOR = {};
for (const [c] of LABELS) LABEL_COLOR[c] = DOMAINS[c[0]].color;


/* ---------------- 全局状态 ---------------- */
const $ = id => document.getElementById(id);
function storageWarning() {
  let warning = $('storageWarning');
  if (!warning) {
    warning = document.createElement('div'); warning.id = 'storageWarning';
    warning.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:1000;background:#742b2b;color:white;padding:8px;text-align:center';
    document.body.appendChild(warning);
  }
  warning.textContent = '本地备份不可用。服务器保存仍可使用；离开前务必确认已保存，断网时请下载备份。';
}
const browserStorage = {
  getItem(key) { try { return window.localStorage.getItem(key); } catch (_) { storageWarning(); return null; } },
  setItem(key, value) { return window.localStorage.setItem(key, value); },
  removeItem(key) { return window.localStorage.removeItem(key); }
};
function remember(key, value) { try { browserStorage.setItem(key, value); } catch (_) { storageWarning(); } }
const urlWho = new URLSearchParams(location.search).get("annotator");
let ANNOTATOR = urlWho || browserStorage.getItem("thvl_who") || "";
if (!ANNOTATOR) {
  ANNOTATOR = (prompt("请输入你的标注者代号（如 A1 / A2）：") || "").trim();
}
if (!ANNOTATOR) { document.body.innerHTML = "<h2 style='padding:40px'>未提供标注者代号，无法开始。</h2>"; throw 0; }
remember("thvl_who", ANNOTATOR);
if (!urlWho) history.replaceState(null, "", "?annotator=" + encodeURIComponent(ANNOTATOR));
$("whoBadge").textContent = "标注者：" + ANNOTATOR;
$("whoBadge").onclick = async () => {
  const w = (prompt("切换标注者代号：", ANNOTATOR) || "").trim();
  if (w && w !== ANNOTATOR && (!cur || await saver.flush(cur.task.video_id))) location.search = "?annotator=" + encodeURIComponent(w);
};

let TASKS = [], PROGRESS = {}, FILTER = "all", SEARCH = "";
let cur = null;            // 当前视频状态 {task, segments[], status, note}
let selId = null;          // 选中段 uid
let uidSeq = 1;
let dirty = false, loading = false, openSequence = 0, EXPERT_ID = 'EXPERT', isExpert = false;
let viewStart = 0, viewDur = 0;   // 时间轴可视窗口（秒）
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const newSegmentId = () => 'h-' + crypto.randomUUID();
const MACHINE_STATUS_TEXT = {ok:'已完成',partial:'部分完成，需补查',error:'处理失败',missing:'未提供',not_run:'尚未运行',stale:'结果已过期',missing_media:'媒体缺失',probe_error:'媒体无法读取'};
const saver = new VersionedSaver({
  storage: browserStorage, prefix: 'thvl_bak_' + ANNOTATOR + '_',
  send: async (record, revision) => {
    const resp = await fetch('/api/save', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({annotator:ANNOTATOR, record, expected_revision:revision})});
    const data = await resp.json();
    if (!resp.ok || !data.ok) { const error = new Error(data.error || resp.status); error.status=resp.status; throw error; }
    return data;
  },
  onState: (vid, state, data, record) => {
    if (state === 'backup_error') { storageWarning(); return; }
    if (state === 'saved') {
      PROGRESS[vid] = {status:record.status, segments:record.segments.length};
      renderList(); refreshProgress();
    }
    if (cur?.task.video_id !== vid) return;
    dirty = saver.dirty(vid);
    const text = {dirty:'未保存…',saving:'保存中…',saved:'已保存',conflict:'保存冲突：请备份当前内容，重新加载后核对'}[state];
    setSaveState(text || ('保存失败：' + (data?.message || state)), ['conflict','error'].includes(state));
  }
});

const fmt = s => AnnotationEditor.formatTime(s) || '不可用';

/* ---------------- 启动 ---------------- */
async function boot() {
  const cfg = await (await fetch('/api/config')).json();
  if (cfg.authenticated_user && cfg.authenticated_user !== ANNOTATOR) {
    location.replace('?annotator=' + encodeURIComponent(cfg.authenticated_user));
    return;
  }
  EXPERT_ID = cfg.expert_id; isExpert = ANNOTATOR === EXPERT_ID;
  if (![...cfg.annotators, EXPERT_ID].includes(ANNOTATOR)) { setSaveState('未知标注者代号，请使用分配的链接', true); return; }
  $('workspaceHint').textContent = isExpert ? '专家裁决工作区' : '独立标注 · 仅保存到你的工作区';
  $('expertTab').hidden = !isExpert;
  const resp = await fetch("tasks.json");
  if (!resp.ok) { setSaveState("缺少任务包，请重新获取仓库", true); return; }
  TASKS = await resp.json();
  await refreshProgress();
  const last = browserStorage.getItem("thvl_last_" + ANNOTATOR);
  const first = TASKS.find(t => t.video_id === last) ||
                TASKS.find(t => !PROGRESS[t.video_id]) || TASKS[0];
  renderList();
  if (first) openVideo(first.video_id);
}

async function refreshProgress() {
  try { PROGRESS = await (await fetch("/api/progress?annotator=" + encodeURIComponent(ANNOTATOR))).json(); }
  catch { PROGRESS = PROGRESS || {}; }

}

/* ---------------- 视频列表 ---------------- */
const STATUS_TEXT = {in_progress:"进行中", done:"已完成", no_risk:"无风险", needs_expert:"待复核"};
function renderList() {
  const box = $("videoList"); box.innerHTML = "";
  for (const t of TASKS) {
    const p = PROGRESS[t.video_id];
    const st = p ? p.status : null;
    if (SEARCH && !t.video_id.toLowerCase().includes(SEARCH)) continue;
    if (FILTER === "todo" && p) continue;
    if (FILTER === "done" && !p) continue;
    const div = document.createElement("div");
    div.className = "vitem" + (cur && cur.task.video_id === t.video_id ? " cur" : "");
    div.dataset.vid = t.video_id;
    const chip = st ? `<span class="chip st-${st}">已保存</span>` : `<span class="chip st-none">未开始</span>`;
    div.innerHTML = `<div class="vid">${t.video_id}</div>
      <div class="meta">${chip}<span>${fmt(t.duration_s)}</span><span>${p ? p.segments + " 段" : (t.segments.length ? "机标 " + t.segments.length + " 段" : "")}</span></div>`;
    div.tabIndex = 0; div.setAttribute('role', 'button');
    div.setAttribute('aria-label', t.video_id + '，' + (p ? '已保存' : '未保存'));
    div.setAttribute('aria-current', cur?.task.video_id === t.video_id ? 'true' : 'false');
    div.onclick = () => openVideo(t.video_id);
    div.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openVideo(t.video_id); } };
    box.appendChild(div);
  }
  $('listCount').textContent = box.children.length + ' / ' + TASKS.length;
}
$("search").oninput = e => { SEARCH = e.target.value.trim().toLowerCase(); renderList(); };
document.querySelectorAll(".filterRow button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".filterRow button").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); FILTER = b.dataset.f; renderList();
});

/* ---------------- 打开视频 ---------------- */
async function openVideo(vid) {
  if (loading || cur?.task.video_id === vid) return;
  loading = true;
  const sequence = ++openSequence;
  if (cur && !(await flushBeforeSwitch())) { loading = false; return; }
  const task = TASKS.find(t => t.video_id === vid);
  if (!task) { loading = false; return; }
  let saved = null, context = null;
  try {
    const resp = await fetch(`/api/load?annotator=${encodeURIComponent(ANNOTATOR)}&video_id=${encodeURIComponent(vid)}`);
    saved = await resp.json();
    if (!resp.ok) throw new Error(saved.error || '无法读取已保存标注');
    if (saved && saved.task_version !== task.task_version) throw new Error('任务版本已变化，已有标注已保留；请先迁移/核对旧版本');
    if (isExpert) {
      const response = await fetch(`/api/expert-context?annotator=${encodeURIComponent(ANNOTATOR)}&video_id=${encodeURIComponent(vid)}`);
      context = await response.json(); if (!response.ok) throw new Error(context.error);
    }
  } catch (e) { loading = false; setSaveState(e.message, true); return; }
  if (sequence !== openSequence) { loading = false; return; }
  // Editing can continue while the next video's read request is pending.
  if (cur && !(await flushBeforeSwitch())) { loading = false; return; }
  remember('thvl_last_' + ANNOTATOR, vid);
  const serverRevision = saved?.revision || 0;
  let recovered = false;
  try {
    const backup = JSON.parse(browserStorage.getItem('thvl_bak_' + ANNOTATOR + '_' + vid) || 'null');
    if (backup?.record?.task_version === task.task_version && confirm('发现本地未保存内容，是否恢复？若另一页面也有修改，请先核对。')) {
      saved = backup.record; recovered = true;
    }
  } catch { /* Leave unreadable backups intact for manual recovery. */ }
  cur = {task, segments:[], status:'in_progress', note:'', review_decisions:{}, whole_video_reviewed:false,
         source_signatures:context?.source_signatures || {}, adjudication_note:''};
  selId = null; dirty = false; setSaveState('');
  const srcSegs = saved && saved.segments ? saved.segments : task.segments;
  cur.segments = AnnotationEditor.draftSegments(srcSegs, !!saved).map(s => ({...s, segment_id:s.segment_id || newSegmentId(), uid:uidSeq++, edited:!!s.edited}));
  if (saved) {
    for (const key of ['status','note','review_decisions','whole_video_reviewed','adjudication_note']) {
      if (saved[key] != null) cur[key] = structuredClone(saved[key]);
    }
    if (isExpert && JSON.stringify(saved.source_signatures) !== JSON.stringify(context.source_signatures)) {
      cur.status='in_progress'; cur.adjudication_note=''; recovered=true;
      setSaveState('人工结果已变化，请重新核对两份来源', true);
    }
  }
  saver.load(vid, serverRevision);
  $('adjudicationNote').value = cur.adjudication_note; $('expertResult').textContent = '';
  setSaveState(saved ? '已保存' : '修改后自动保存');
  $('machineState').dataset.machineStatus=task.machine_status; $('machineState').dataset.mediaStatus=task.media_status;
  $('machineState').textContent = `媒体：${task.media_status === 'ok' ? '可用' : (MACHINE_STATUS_TEXT[task.media_status] || '不可用')}；机器处理：${MACHINE_STATUS_TEXT[task.machine_status] || '状态待核查'}。机器未报区间仍需全片检查。`;
  selId = cur.segments[0]?.uid ?? null;
  player.reset(task.duration_s, task.media_status === 'ok');
  $('currentVideo').textContent = vid;
  $('prevVideo').disabled = TASKS.indexOf(task) === 0;
  $('nextVideo').disabled = TASKS.indexOf(task) === TASKS.length - 1;
  $('tCur').textContent = fmt(0); $('tDur').textContent = fmt(task.duration_s);
  if (task.media_status === 'ok') $("video").src = "/media/" + encodeURIComponent(vid);
  else $('video').removeAttribute('src');
  $('btnNewSeg').disabled = task.media_status !== 'ok';
  $("video").load();
  viewStart = 0; viewDur = task.duration_s || 0;
  $("zoomLabel").textContent = "全片";
  renderSegRows(); renderEditor(); drawTimeline();
  renderList();
  renderReviewQueue(); renderMachineSuggestions(); renderExpert(context); showReference(null);
  loadTranscript(vid);
  loading = false;
  if (recovered) markDirty();
}

/* ---------------- 播放器 ---------------- */
const V = $("video");
const player = new AnnotationPlayer(V, {
  storage:browserStorage, key:'thvl_playback_' + ANNOTATOR,
  onChange:() => { if (typeof player !== 'undefined') renderPlayback(); },
  onError:message => { $('playbackNotice').textContent = message; }
});
function renderPlayback() {
  $("tCur").textContent = fmt(V.currentTime);
  $('playPause').textContent = V.paused ? '▶ 播放' : 'Ⅱ 暂停';
  $('playPause').disabled = !player.available;
  $('btnPlaySeg').disabled = !player.available; $('btnLoopSeg').disabled = !player.available;
  document.querySelectorAll('[data-seek]').forEach(b => b.disabled = !player.available);
  document.querySelectorAll('[data-rate]').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.rate) === player.rate ? 'true' : 'false'));
  $('rateHint').textContent = player.rate < 1 ? '慢放 · 精看细节' : player.rate === 1 ? '原速' : '快放 · 浏览全片';
  $('btnLoopSeg').setAttribute('aria-pressed', player.range?.loop ? 'true' : 'false');
  $('btnLoopSeg').textContent = player.range?.loop ? '↻ 停止循环' : '↻ 循环本段';
  $('playbackNotice').textContent = player.range ? `${player.range.loop ? '循环片段' : '播放片段'} ${fmt(player.range.start)}–${fmt(player.range.end)} · Esc 退出` : '';
}
$('playPause').onclick = () => player.toggle();
document.querySelectorAll('[data-rate]').forEach(b => b.onclick = () => player.setRate(b.dataset.rate));
document.querySelectorAll('[data-seek]').forEach(b => b.onclick = () => player.skip(Number(b.dataset.seek)));
function adjacentVideo(delta) { if (cur) { const task = TASKS[TASKS.indexOf(cur.task) + delta]; if (task) openVideo(task.video_id); } }
$('prevVideo').onclick = () => adjacentVideo(-1);
$('nextVideo').onclick = () => adjacentVideo(1);
renderPlayback();
V.onerror = () => {
  player.reset(cur?.task.duration_s, false); $('btnNewSeg').disabled = true;
  if (cur?.task.media_status === 'ok') $('machineState').textContent = '当前浏览器无法解码此视频。请换兼容浏览器或由管理员制作保留时间轴的播放副本；不要据此确认无风险。';
};
V.onloadeddata = () => {
  if (!V.videoWidth || !V.videoHeight) V.onerror();
};
V.ontimeupdate = () => { $("tCur").textContent = fmt(V.currentTime); positionPlayhead(); highlightTranscript(); };
V.onloadedmetadata = () => {
  if (cur && !cur.task.duration_s) { cur.task.duration_s = V.duration; viewDur = V.duration; }
  $("tDur").textContent = fmt(cur.task.duration_s || V.duration || 0);
  player.duration = cur?.task.duration_s || V.duration || 0; player.applyRate();
  drawTimeline();
};

/* ---------------- 时间轴 ---------------- */
function px2t(x) { const r = $("lanes").getBoundingClientRect(); return viewStart + (x / r.width) * viewDur; }
function t2px(t) { const r = $("lanes").getBoundingClientRect(); return ((t - viewStart) / viewDur) * r.width; }

function drawTimeline() {
  if (!cur || !viewDur) return;
  const ruler = $("ruler"); ruler.innerHTML = "";
  const span = viewDur;
  const steps = [0.5,1,2,5,10,15,30,60,120,300,600,900];
  const step = steps.find(s => span / s <= 14) || 1800;
  for (let t = Math.ceil(viewStart / step) * step; t <= viewStart + span + 1e-6; t += step) {
    const el = document.createElement("div");
    el.className = "tick"; el.style.left = (100 * (t - viewStart) / span) + "%";
    el.textContent = fmt(t); ruler.appendChild(el);
  }
  const lanes = $("lanes");
  lanes.querySelectorAll(".seg").forEach(e => e.remove());
  // 简单泳道分配，避免重叠段互相遮挡
  const laneEnds = [];
  for (const s of [...cur.segments].sort((a,b) => a.start_s - b.start_s)) {
    if (s.end_s < viewStart || s.start_s > viewStart + viewDur) continue;
    let lane = laneEnds.findIndex(e => e <= s.start_s);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = s.end_s;
    const el = document.createElement("div");
    el.className = "seg" + (s.uid === selId ? " sel" : "");
    el.style.left = (100 * (s.start_s - viewStart) / span) + "%";
    el.style.width = Math.max(0.4, 100 * (s.end_s - s.start_s) / span) + "%";
    el.style.top = (2 + lane * 26) + "px";
    el.style.background = s.labels.length ? LABEL_COLOR[s.labels[0]] : "#5a6172";
    el.dataset.uid = s.uid;
    el.title = `${fmt(s.start_s)}–${fmt(s.end_s)} ${s.labels.map(c => c + " " + (LABEL_NAME[c]||"")).join(" / ") || "(未选标签)"}`;
    el.innerHTML = `<div class="grip l"></div><div class="grip r"></div><div class="lb">${s.labels.join("+") || "?"}</div>`;
    lanes.appendChild(el);
  }
  $("lanes").style.height = Math.max(54, (laneEnds.length) * 26 + 6) + "px";
  positionPlayhead();
}
function positionPlayhead() {
  if (!cur || !viewDur) return;
  $("playhead").style.left = (100 * (V.currentTime - viewStart) / viewDur) + "%";
}

$("ruler").onpointerdown = e => { if (cur) player.seek(px2t(e.clientX - $("lanes").getBoundingClientRect().left)); };
let drag = null;
$("lanes").onpointerdown = e => {
  const segEl = e.target.closest(".seg");
  if (!segEl) return;
  const uid = +segEl.dataset.uid;
  selectSeg(uid);
  const s = cur.segments.find(x => x.uid === uid);
  const mode = e.target.classList.contains("l") ? "l" : e.target.classList.contains("r") ? "r" : "m";
  drag = {uid, mode, x0: e.clientX, st: s.start_s, en: s.end_s};
  e.target.setPointerCapture(e.pointerId);
  e.preventDefault();
};
window.onpointermove = e => {
  if (!drag) return;
  const r = $("lanes").getBoundingClientRect();
  const dt = ((e.clientX - drag.x0) / r.width) * viewDur;
  const s = cur.segments.find(x => x.uid === drag.uid);
  if (drag.mode === "m") {
    const len = drag.en - drag.st;
    s.start_s = Math.max(0, Math.min(drag.st + dt, cur.task.duration_s - len));
    s.end_s = s.start_s + len;
  } else if (drag.mode === "l") {
    s.start_s = Math.max(0, Math.min(drag.st + dt, s.end_s - 0.1));
  } else {
    s.end_s = Math.min(cur.task.duration_s, Math.max(drag.en + dt, s.start_s + 0.1));
  }
  s.edited = true; s.needs_review = false; markDirty();
  drawTimeline(); fillEditor(s);
};
window.onpointerup = () => { if (drag) { drag = null; renderSegRows(); } };
$("lanes").onwheel = e => {
  e.preventDefault();
  if (!cur || !viewDur) return;
  if (e.ctrlKey) {
    const factor = e.deltaY > 0 ? 1.5 : 1/1.5;
    const anchor = px2t(e.clientX - $("lanes").getBoundingClientRect().left);
    const newDur = Math.min(cur.task.duration_s, Math.max(4, viewDur * factor));
    viewStart = Math.max(0, Math.min(anchor - (anchor - viewStart) * (newDur / viewDur), cur.task.duration_s - newDur));
    viewDur = newDur;
    $("zoomLabel").textContent = viewDur >= cur.task.duration_s - 0.01 ? "全片" : fmt(viewDur) + " 窗";
    drawTimeline();
  } else {
    player.skip(e.deltaY > 0 ? 2 : -2);
  }
};
const zoom = f => {
  if (!cur || !viewDur) return;
  const c = V.currentTime || (viewStart + viewDur / 2);
  const newDur = Math.min(cur.task.duration_s, Math.max(4, viewDur * f));
  viewStart = Math.max(0, Math.min(c - newDur / 2, cur.task.duration_s - newDur));
  viewDur = newDur;
  $("zoomLabel").textContent = viewDur >= cur.task.duration_s - 0.01 ? "全片" : fmt(viewDur) + " 窗";
  drawTimeline();
};
$("zoomIn").onclick = () => zoom(1/4);
$("zoomOut").onclick = () => zoom(4);
$("zoomAll").onclick = () => { if (!cur) return; viewStart = 0; viewDur = cur.task.duration_s; $("zoomLabel").textContent = "全片"; drawTimeline(); };

/* ---------------- 段落编辑 ---------------- */
$("btnNewSeg").onclick = () => {
  if (!cur || cur.task.media_status !== 'ok' || V.currentTime >= cur.task.duration_s) return;
  const t = V.currentTime;
  const s = {uid: uidSeq++, segment_id:newSegmentId(), start_s: Math.max(0, t), end_s: Math.min(cur.task.duration_s, t + 5),
             labels: [], modalities: ["visual"], rationale: "", needs_review: false,
             origin: "human", edited: true};
  cur.segments.push(s);
  selectSeg(s.uid); markDirty(); drawTimeline(); renderSegRows();
};
function selectSeg(uid) {
  if (selId !== uid) player.clearRange();
  selId = uid;
  renderEditor(); drawTimeline();
  document.querySelectorAll("#segRows tr").forEach(tr => tr.classList.toggle("cur", +tr.dataset.uid === uid));
}
function currentSeg() { return cur ? cur.segments.find(s => s.uid === selId) : null; }

function renderEditor() {
  $("editorEmpty").hidden = !!currentSeg();
  const s = currentSeg();
  $("editor").style.display = s ? "grid" : "none";
  if (!s) return;
  fillEditor(s);
  const grid = $("edLabels"); grid.innerHTML = "";
  for (const [code, name] of LABELS) {
    const b = document.createElement("button");
    b.textContent = `${code} ${name}`;
    b.style.background = LABEL_COLOR[code];
    b.className = s.labels.includes(code) ? "on" : "";
    b.onclick = () => {
      const i = s.labels.indexOf(code);
      i >= 0 ? s.labels.splice(i, 1) : s.labels.push(code);
      s.labels.sort((a, b2) => LABELS.findIndex(l => l[0] === a) - LABELS.findIndex(l => l[0] === b2));
      s.edited = true; s.needs_review = false; markDirty(); renderEditor(); drawTimeline(); renderSegRows();
    };
    grid.appendChild(b);
  }
  $("modVisual").checked = s.modalities.includes("visual");
  $("modTextual").checked = s.modalities.includes("textual");
  $("modAuditory").checked = s.modalities.includes("auditory");
  $("edRationale").value = s.rationale || "";
  $("edOrigin").textContent = s.origin === "machine"
    ? `机器预标注${s.confidence != null ? " · 置信度 " + s.confidence : ""}` : "人工新建";
  renderSelectedMachine(s);
}
function fillEditor(s) {
  $("edStart").value = fmt(s.start_s); $("edEnd").value = fmt(s.end_s);
  for (const id of ['edStart','edEnd']) $(id).removeAttribute('aria-invalid');
  $('edWarn').textContent = '';
}
function updateBoundary(input, key) {
  const s = currentSeg(); if (!s) return;
  const value = AnnotationEditor.parseTime(input.value);
  const start = key === 'start_s' ? value : s.start_s;
  const end = key === 'end_s' ? value : s.end_s;
  if (value === null || start < 0 || !(start < end) || end > cur.task.duration_s) {
    input.setAttribute('aria-invalid','true');
    $('edWarn').textContent = '请输入分:秒（如 01:35.5），起点须早于终点且不超过视频时长。无效输入未保存。';
    return;
  }
  s[key] = value; s.edited = true; s.needs_review = false;
  markDirty(); drawTimeline(); renderSegRows(); fillEditor(s); renderSelectedMachine(s);
}
$('edStart').onchange = e => updateBoundary(e.target, 'start_s');
$('edEnd').onchange = e => updateBoundary(e.target, 'end_s');
document.querySelectorAll(".nudge button").forEach(b => b.onclick = () => {
  const s = currentSeg(); if (!s) return;
  const [which, d] = b.dataset.n.split(",");
  const delta = parseFloat(d);
  if (which === "st") s.start_s = Math.max(0, Math.min(s.start_s + delta, s.end_s - 0.1));
  else s.end_s = Math.min(cur.task.duration_s, Math.max(s.end_s + delta, s.start_s + 0.1));
  s.edited = true; s.needs_review = false; markDirty(); drawTimeline(); renderSegRows(); fillEditor(s);
});
$("btnSetStart").onclick = () => { const s = currentSeg(); if (s) { s.start_s = Math.min(V.currentTime, s.end_s - 0.1); s.edited = true; s.needs_review = false; markDirty(); drawTimeline(); renderSegRows(); fillEditor(s); } };
$("btnSetEnd").onclick = () => { const s = currentSeg(); if (s) { s.end_s = Math.max(V.currentTime, s.start_s + 0.1); s.edited = true; s.needs_review = false; markDirty(); drawTimeline(); renderSegRows(); fillEditor(s); } };
$("btnPlaySeg").onclick = () => { const s = currentSeg(); if (s) player.playSegment(s.start_s, s.end_s); };
$('btnLoopSeg').onclick = () => {
  const s = currentSeg(); if (!s) return;
  if (player.range?.loop) player.clearRange(); else player.playSegment(s.start_s, s.end_s, true);
};
$("btnDelSeg").onclick = () => { const s = currentSeg(); if (!s) return;
  if (!confirm("删除该段落？")) return;
  player.clearRange();
  cur.segments = cur.segments.filter(x => x.uid !== s.uid); selId = cur.segments[0]?.uid ?? null;
  markDirty(); drawTimeline(); renderSegRows(); renderEditor(); };
for (const id of ["modVisual","modTextual","modAuditory"]) $(id).onchange = () => {
  const s = currentSeg(); if (!s) return;
  s.modalities = [["modVisual","visual"],["modTextual","textual"],["modAuditory","auditory"]]
    .filter(([i]) => $(i).checked).map(([,m]) => m);
  s.edited = true; s.needs_review = false; markDirty();
};
$("edRationale").oninput = e => { const s = currentSeg(); if (s) { s.rationale = e.target.value; s.edited = true; s.needs_review = false; markDirty(); renderSegRows(); } };

function renderSegRows() {
  const tb = $("segRows"); tb.innerHTML = "";
  if (!cur) return;
  [...cur.segments].sort((a,b) => a.start_s - b.start_s).forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.dataset.uid = s.uid;
    if (s.uid === selId) tr.className = "cur";
    const chips = s.labels.map(c => `<span class="lchip" style="background:${LABEL_COLOR[c]}">${c}</span>`).join("") || `<span class="badge warn">未选标签</span>`;
    const src = s.origin === "machine" ? `<span class="badge src">机器</span>` : `<span class="badge">人工</span>`;
    const marks = !s.rationale?.trim() || !s.labels.length || !s.modalities.length || s.needs_review
      ? '<span class="badge warn">待填写</span>' : '<span class="badge">已填写</span>';
    tr.innerHTML = `<td>${i+1}</td><td>${fmt(s.start_s)}</td><td>${fmt(s.end_s)}</td><td>${chips}</td><td>${src}</td><td>${marks}</td>`;
    tr.onclick = () => { selectSeg(s.uid); player.seek(s.start_s); };
    tb.appendChild(tr);
  });
  $('segmentCount').textContent = cur.segments.length + ' 段';
  if (!cur.segments.length) tb.innerHTML = '<tr><td colspan="6" class="hint">尚无片段。请全片检查，发现事件后新建。</td></tr>';
  validate();
}

/* Original machine suggestions are read-only; annotators edit independent copies. */
function renderMachineSuggestions() {
  const box = $('machineSuggestions'); box.replaceChildren();
  const suggestions = cur?.task.segments || [];
  $('machineCount').textContent = suggestions.length + ' 段';
  for (const suggestion of suggestions) {
    const card = document.createElement('article'); card.className = 'machineSuggestion';
    const jump = document.createElement('button'); jump.className = 'machineJump';
    jump.textContent = fmt(suggestion.start_s) + '–' + fmt(suggestion.end_s) + '  定位建议';
    jump.disabled = cur.task.media_status !== 'ok';
    jump.onclick = () => {
      const match = cur.segments.find(s => suggestion.segment_id && s.segment_id === suggestion.segment_id);
      if (match) selectSeg(match.uid);
      player.seek(suggestion.start_s);
    };
    const labels = document.createElement('div'); labels.className = 'machineLabels';
    for (const code of suggestion.labels || []) {
      const chip = document.createElement('span'); chip.className = 'lchip'; chip.style.background = LABEL_COLOR[code];
      chip.textContent = code + ' ' + (LABEL_NAME[code] || ''); labels.appendChild(chip);
    }
    const rationale = document.createElement('p'); rationale.className = 'machineRationale';
    rationale.textContent = suggestion.rationale || (suggestion.rationales || []).join('；') || '未提供理由，请结合视频核对。';
    const meta = document.createElement('div'); meta.className = 'hint';
    const modalities = {visual:'画面',textual:'语音 / 字幕语义',auditory:'声音'};
    meta.textContent = (suggestion.modalities || []).map(m => modalities[m] || m).join(' · ');
    if (Number.isFinite(suggestion.confidence)) meta.textContent += ' · 模型置信度 ' + Math.round(suggestion.confidence * 100) + '%（非准确率）';
    card.append(jump, labels, rationale, meta);
    if (suggestion.needs_review) {
      const review = document.createElement('p'); review.className = 'machineWarning';
      review.textContent = '待人工核对：' + ((suggestion.review_reasons || []).join('；') || '模型证据不确定'); card.appendChild(review);
    }
    box.appendChild(card);
  }
  if (!suggestions.length) box.textContent = '暂无机器候选。这不代表没有风险，请完整查看视频并补标。';
  $('jumpReview').textContent = '查看机器待检查区间（' + (cur?.task.review_items || []).length + ' 项）';
}
function showReference(id) {
  $('referenceDeck').classList.toggle('collapsed', !id);
  document.querySelectorAll('.referenceBody').forEach(el => el.hidden = el.id !== id);
  document.querySelectorAll('[data-panel]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.panel === id)));
}
document.querySelectorAll('[data-panel]').forEach(el => el.onclick = () => showReference(el.getAttribute('aria-pressed') === 'true' ? null : el.dataset.panel));
$('jumpReview').onclick = () => showReference('reviewPanel');
function renderSelectedMachine(segment) {
  const box = $('selectedMachineReason'); box.replaceChildren();
  const exact = cur.task.segments.find(s => s.segment_id === segment.segment_id);
  const suggestions = exact ? [exact] : cur.task.segments.filter(s => s.start_s < segment.end_s && s.end_s > segment.start_s);
  for (const suggestion of suggestions) {
    const card = document.createElement('article');
    const title = document.createElement('h4'); title.textContent = fmt(suggestion.start_s) + '–' + fmt(suggestion.end_s);
    const labels = document.createElement('p'); labels.className = 'hint'; labels.textContent = (suggestion.labels || []).map(c => c+' '+(LABEL_NAME[c] || '')).join(' / ');
    const reason = document.createElement('p'); reason.className = 'machineRationale';
    reason.textContent = suggestion.rationale || (suggestion.rationales || []).join('；') || '机器未提供理由。';
    card.append(title, labels, reason); box.appendChild(card);
  }
  if (!suggestions.length) box.textContent = '这是人工新增片段，暂无重叠的机器建议。';
  else if (!exact) box.prepend(document.createTextNode('以下为与当前区间重叠的机器建议：'));
}

/* ---------------- 转写 ---------------- */
let TR = null;
async function loadTranscript(vid) {
  TR = null; $("transcriptCoverage").textContent = ""; $("transcript").innerHTML = "<span class='hint'>（无转写）</span>";
  try {
    const data = await (await fetch("/api/transcript?video_id=" + encodeURIComponent(vid))).json();
    if (cur?.task.video_id !== vid) return;
    if (!data || !['ok','partial'].includes(data.status)) { $('transcriptCoverage').textContent = '转写状态：' + (data?.status || 'missing') + '；语言证据需人工核对'; return; }
    if (data.status === 'partial') $('transcriptCoverage').textContent = '音频仅部分完成：下列是已获得的转写，未覆盖区间不能视为静音或无风险。';
    if (!data || !data.segments || !data.segments.length) return;
    TR = data.segments.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && typeof s.text === 'string');
    $("transcript").innerHTML = TR.map((s, i) =>
      `<div class="tline" data-i="${i}"><span class="ts">${fmt(s.start)}</span>${escapeHtml(s.text)}</div>`).join("");
    $("transcript").querySelectorAll(".tline").forEach(el =>
      el.onclick = () => player.seek(TR[+el.dataset.i].start));
  } catch { /* 无转写不影响标注 */ }
}
function highlightTranscript() {
  if (!TR || $('transcriptPanel').hidden) return;
  const t = V.currentTime;
  $("transcript").querySelectorAll(".tline").forEach(el => {
    const s = TR[+el.dataset.i];
    el.classList.toggle("cur", t >= s.start && t <= s.end);
  });
}

/* ---------------- 自动保存；切换之前等待当前修改落盘 ---------------- */
$('adjudicationNote').oninput = e => { if (cur) { cur.adjudication_note = e.target.value; markDirty(); } };
function validate() {
  // Drafts may be incomplete. Field-level marks guide editing without blocking saves.
}
async function flushBeforeSwitch() {
  const invalid = document.querySelector('#editor [aria-invalid="true"]');
  if (invalid) { invalid.focus(); setSaveState('时间格式无效，请改正后再切换；其余改动已保留', true); return false; }
  return saveNow();
}
$('confirmExpert').onclick = async () => {
  if (!cur || !isExpert) return;
  if (!cur.adjudication_note.trim()) { $('expertResult').textContent='请先填写裁决说明'; return; }
  if (!V.videoWidth || !V.videoHeight || V.error) { $('expertResult').textContent='请先解决播放问题并完整复看视频'; return; }
  if (!confirm('确认已经完整复看视频、检查两份人工记录，并完成本视频的最终裁决？')) return;
  cur.status = cur.segments.length ? 'done' : 'no_risk'; cur.whole_video_reviewed = true;
  saver.mark(cur.task.video_id, recordForSave());
  $('expertResult').textContent = await saveNow() ? '最终裁决已保存' : '尚未通过校验，请检查保存提示';
};

function recordForSave() {
  return {review_workflow:'autosave', video_id:cur.task.video_id, task_version:cur.task.task_version, status:cur.status, note:cur.note,
    review_decisions:cur.review_decisions, whole_video_reviewed:cur.whole_video_reviewed,
    ...(isExpert ? {source_signatures:cur.source_signatures, adjudication_note:cur.adjudication_note} : {}),
    segments:[...cur.segments].sort((a,b) => a.start_s-b.start_s).map(s => {
      const {uid, ...record} = s;
      return {...record, start_s:+s.start_s.toFixed(6), end_s:+s.end_s.toFixed(6),
        rationale:s.rationale || '', needs_review:!!s.needs_review, origin:s.origin || 'human', edited:!!s.edited};
    })};
}

function markDirty() {
  player.clearRange();
  if (cur) { cur.status='in_progress'; cur.whole_video_reviewed=false; $('expertResult').textContent=''; saver.mark(cur.task.video_id, recordForSave()); }
}
async function saveNow(checkpoint = false) {
  if (checkpoint && cur) saver.mark(cur.task.video_id, recordForSave());
  return cur ? saver.flush(cur.task.video_id) : true;
}
function setSaveState(txt, bad) { $("saveState").textContent = txt; $("saveState").className = bad ? "bad" : ""; }
window.onbeforeunload = () => saver.anyDirty() ? "有未保存修改" : null;

function renderReviewQueue() {
  const box = $('reviewQueue'); box.innerHTML = '';
  for (const item of cur.task.review_items || []) {
    const row=document.createElement('div'); row.style.marginBottom='8px';
    const jump=document.createElement('button'); jump.textContent=fmt(item.start_s)+'–'+fmt(item.end_s);
    jump.disabled=cur.task.media_status !== 'ok' || !Number.isFinite(item.start_s);
    jump.onclick=()=> player.seek(item.start_s);
    const description=document.createElement('span');
    const kindText={model_rejected:'模型否决，需人工核对',budget_deferred:'机器未处理的候选',failed_audio_window:'音频分析不完整',failed_scan:'全片粗扫失败',failed_scan_window:'粗扫失败区间',failed_refine_window:'精判失败区间',language_evidence_unavailable:'语言证据未获得',invalid_model_output:'机器输出无效',pipeline_failure:'机器处理未完成',missing_preannotation:'缺少机器预标注',media_unavailable:'媒体不可用'};
    kindText.candidate_unresolved_or_displaced='候选可能错位或未落实，需补查';
    description.textContent=' '+(kindText[item.kind] || '待检查区间')+' '+(item.labels || []).join('/')+' ';
    description.title=item.reason || item.evidence || '';
    const reason=document.createElement('p'); reason.className='hint'; reason.textContent=item.reason || item.evidence || '';
    row.append(jump,description,reason);box.appendChild(row);
  }
  if (!box.children.length) box.textContent='无额外机器候选；仍须全片检查漏报。';
}

function renderExpert(context) {
  const box=$('expertSources'); box.innerHTML='';
  if (!isExpert || !context) return;
  const cards=document.createElement('div');cards.className='sourceCards';box.appendChild(cards);
  const segmentText=s => s ? `${fmt(s.start_s)}–${fmt(s.end_s)} ${(s.labels || []).map(c => c+' '+(LABEL_NAME[c] || '')).join(' / ')}\n${s.rationale || ''}${s.needs_review ? ' ⚠ 待复核' : ''}` : '未标出对应片段';
  for (const [who,source] of Object.entries(context.annotations)) {
    const card=document.createElement('div');card.className='sourceCard';
    const heading=document.createElement('h3'); heading.textContent=who+'：'+(source ? '已保存记录' : '暂无记录');
    const note=document.createElement('p');note.textContent=source?.note || '无视频备注';
    const button=document.createElement('button');button.textContent='以 '+who+' 的片段作为本次裁决起稿';button.disabled=!source;
    button.onclick=()=> {
      if (!confirm('将当前专家片段替换为 '+who+' 的片段作为起稿？两份人工原件均保留。')) return;
      cur.segments=structuredClone(source.segments).map(s=>({...s,uid:uidSeq++}));
      cur.status='in_progress';cur.whole_video_reviewed=false;
      selId=cur.segments[0]?.uid ?? null;markDirty();renderSegRows();renderEditor();drawTimeline();
    };
    card.append(heading,note,button);
    for (const segment of source?.segments || []) {
      const jump=document.createElement('button');jump.className='sourceSegment';jump.style.whiteSpace='pre-wrap';jump.textContent=segmentText(segment);
      jump.onclick=()=> player.seek(segment.start_s);card.appendChild(jump);
    }
    cards.appendChild(card);
  }
  const caption=document.createElement('p');caption.className='hint';caption.textContent='区间对比：按相同标签的时间重叠配对。未配对项及边界差异均需核对；局部重叠度不是整体标注一致率。';box.appendChild(caption);
  const table=document.createElement('table');table.className='compareTable';
  const head=document.createElement('tr');
  for(const label of [...Object.keys(context.annotations),'时间重叠度']) {const th=document.createElement('th');th.textContent=label;head.appendChild(th);}
  table.appendChild(head);
  for(const pair of context.comparison.pairs) {
    const row=document.createElement('tr');
    for(const value of [segmentText(pair.first),segmentText(pair.second),Math.round(pair.temporal_iou*100)+'%']) {
      const td=document.createElement('td');td.style.whiteSpace='pre-wrap';td.textContent=value;row.appendChild(td);
    }
    table.appendChild(row);
  }
  box.appendChild(table);
}

/* ---------------- 备份 / 弹窗 / 快捷键 ---------------- */
$("btnBackup").onclick = () => {
  if (!cur) return;
  const blob = new Blob([JSON.stringify(recordForSave(), null, 1)], {type: "application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${ANNOTATOR}_${cur.task.video_id}.json`;
  a.click();
};
// Read the reference directly from the guideline, so definitions cannot drift.
function renderLabelReference(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s+三[、.．]/.test(line));
  if (start < 0) throw new Error('未找到标注规范第三部分');
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  const inline = text => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const html = []; let card = false;
  for (const line of lines.slice(start + 1, end)) {
    const text = line.trim();
    if (!text || /^---+$/.test(text)) continue;
    if (/^###\s/.test(text)) {
      if (card) { html.push('</article>'); card = false; }
      html.push('<h3>' + inline(text.replace(/^###\s+/, '')) + '</h3>');
    } else if (/^\* \*\*[A-F]\d/.test(line)) {
      if (card) html.push('</article>');
      html.push('<article class="referenceLabel"><p>' + inline(text.replace(/^\*\s+/, '')) + '</p>'); card = true;
    } else {
      html.push('<p class="referenceBoundary">' + inline(text.replace(/^\*\s+/, '')) + '</p>');
    }
  }
  if (card) html.push('</article>');
  return html.join('');
}
$('btnRef').onclick = async () => {
  $('modalRef').style.display = 'block';
  $('refBody').textContent = '正在加载标注规范第三部分…';
  try {
    const response = await fetch('instructions.md', {cache:'no-store'});
    if (!response.ok) throw new Error('读取规范失败：HTTP ' + response.status);
    $('refBody').innerHTML = renderLabelReference(await response.text());
  } catch (error) {
    $('refBody').textContent = error.message + '。请检查服务，或打开仓库内 annotate/instructions.md 第三部分。';
  }
};
$("btnKeys").onclick = () => $("modalKeys").style.display = "block";
document.querySelectorAll("[data-close]").forEach(el => el.onclick =
  () => el.closest(".modal").style.display = "none");
window.onclick = e => { if (e.target.classList.contains("modal")) e.target.style.display = "none"; };

document.onkeydown = e => {
  const active = document.activeElement;
  const typing = /INPUT|TEXTAREA|SELECT/.test(active.tagName) || active.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(true); return; }
  if (e.key === 'Escape') { document.querySelectorAll('.modal').forEach(m => m.style.display = 'none'); player.clearRange(); return; }
  if (typing || !cur || e.ctrlKey || e.metaKey || e.altKey || [...document.querySelectorAll('.modal')].some(m => m.style.display === 'block')) return;
  if (e.key === ' ' && /BUTTON|A|VIDEO/.test(active.tagName)) return;
  const actions = {
    ' ':() => { if (!e.repeat) player.toggle(); },
    ArrowLeft:() => player.skip(e.shiftKey ? -5 : -1),
    ArrowRight:() => player.skip(e.shiftKey ? 5 : 1),
    ',':() => { V.pause(); player.skip(-0.1); },
    '.':() => { V.pause(); player.skip(0.1); },
    '-':() => player.stepRate(-1), '=':() => player.stepRate(1), '+':() => player.stepRate(1),
    '[':() => { if (currentSeg()) $('btnSetStart').click(); },
    ']':() => { if (currentSeg()) $('btnSetEnd').click(); },
    n:() => { if (!e.repeat) $('btnNewSeg').click(); }, N:() => { if (!e.repeat) $('btnNewSeg').click(); },
    Delete:() => { if (!e.repeat && currentSeg()) $('btnDelSeg').click(); }
  };
  if (actions[e.key]) { e.preventDefault(); actions[e.key](); }
};

$('btnSave').onclick = () => saveNow(true);
window.addEventListener('resize', drawTimeline);
boot().catch(e => setSaveState('初始化失败：'+e.message, true));
