/* クイズ勉強帳 — 依存なしの単一ページアプリ */
'use strict';

const CFG = window.QUIZ_CONFIG || {};
const GROUP_KEYS = ['subregion', 'era', 'dynasty', 'civilization', 'festival', 'category', 'role'];

// ---------- storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  decks: [],
  byId: {},
  progress: LS.get('qs.progress', {}),   // itemKey -> {c, w, s, t}
  settings: LS.get('qs.settings', {}),   // {gasUrl, passcode, quizMode, count}
  lastSync: LS.get('qs.lastSync', 0),
  session: null,
  sync: 'off',
};

const gasUrl = () => (state.settings.gasUrl || CFG.GAS_URL || '').trim();
const canWrite = () => !!(gasUrl() && state.settings.passcode);
const saveSettings = () => LS.set('qs.settings', state.settings);
const saveProgress = () => LS.set('qs.progress', state.progress);

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const alts = v => String(v ?? '').split('|').map(s => s.trim()).filter(Boolean);
const disp = v => alts(v)[0] || '';
const usable = v => { const d = disp(v); return !!d && !/^該当(作)?なし$/.test(d); };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const uniq = a => [...new Set(a)];

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function flagImg(code, cls = '') {
  const c = disp(code).toLowerCase();
  if (!/^[a-z]{2}$/.test(c)) return esc(code);
  return `<img class="flag ${cls}" loading="lazy" alt="国旗" src="https://flagcdn.com/w320/${c}.png">`;
}

function cellHtml(col, v) {
  if (col.type === 'flag') return flagImg(v);
  const a = alts(v);
  if (!a.length) return '';
  return esc(a[0]) + (a.length > 1 ? ` <span class="muted small">(${a.slice(1).map(esc).join('／')})</span>` : '');
}

// 入力回答の正規化：全半角・カナ/かな・記号・空白の揺れを吸収
function norm(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/紀元前|bc/g, '前')
    .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s・･\-ー－‐=＝「」『』()（）\[\]【】〈〉《》、。,.!！?？'"“”‘’〜~]/g, '')
    .replace(/年$/, '');
}

function yearNum(v) {
  const m = String(disp(v)).match(/^(前)?(\d+)(上|下)?/);
  if (!m) return null;
  let n = +m[2];
  if (m[1]) n = -n;
  if (m[3] === '下') n += 0.5;
  return n;
}

// ---------- data loading ----------
async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function addDeck(d) {
  d.rows = d.rows || [];
  d.quizzes = (d.quizzes || []).filter(q => d.columns.some(c => c.key === q.q) && d.columns.some(c => c.key === q.a));
  d.groupKey = GROUP_KEYS.find(k => d.columns.some(c => c.key === k));
  state.decks.push(d);
  state.byId[d.id] = d;
}

async function loadBase() {
  const idx = await fetchJSON('data/index.json');
  const decks = await Promise.all(idx.decks.map(f => fetchJSON('data/' + f).catch(e => { console.warn(e); return null; })));
  decks.filter(Boolean).forEach(addDeck);
}

const NOTE_LABELS = ['note', '補足', 'メモ', '備考'];

// スプレッドシートの各シートをデッキへ反映
// - シート名がデッキIDと一致 → そのデッキに行を追加
// - それ以外 → 新しいデッキ（シート名「カテゴリ/タイトル」、1行目が見出し）
function mergeSheets(sheets) {
  state.decks = state.decks.filter(d => !d._fromSheet);
  state.byId = Object.fromEntries(state.decks.map(d => [d.id, d]));
  state.decks.forEach(d => { d.rows = d.rows.filter(r => r._src !== 'sheet'); });

  for (const s of sheets) {
    const header = s.header.map(h => String(h).trim());
    const rows = s.rows.filter(r => r.some(v => String(v).trim()));
    const base = state.byId[s.name];
    if (base) {
      const keys = header.map(h => {
        const c = base.columns.find(c => c.key === h || c.label === h);
        return c ? c.key : (NOTE_LABELS.includes(h) ? 'note' : null);
      });
      for (const r of rows) {
        const o = { _src: 'sheet' };
        keys.forEach((k, i) => { if (k) o[k] = String(r[i] ?? '').trim(); });
        base.rows.push(o);
      }
      continue;
    }
    const [category, title] = s.name.includes('/') ? s.name.split('/', 2) : ['マイデッキ', s.name];
    const columns = header.map((h, i) => NOTE_LABELS.includes(h)
      ? { key: 'note', label: '補足' }
      : { key: 'c' + i, label: h, ...(h.includes('国旗') ? { type: 'flag' } : {}) });
    const main = columns.filter(c => c.key !== 'note');
    const quizzes = [];
    if (main.length >= 2) {
      for (const c of main.slice(1)) {
        quizzes.push({ q: main[0].key, a: c.key, label: `${main[0].label} → ${c.label}` });
        quizzes.push({ q: c.key, a: main[0].key, label: `${c.label} → ${main[0].label}` });
      }
    }
    addDeck({
      id: 'sheet-' + s.name, title: title.trim(), category: category.trim(), description: 'スプレッドシートで管理',
      columns, quizzes, _fromSheet: true, _sheetName: s.name,
      rows: rows.map(r => Object.fromEntries(columns.map((c, i) => [c.key, String(r[i] ?? '').trim()]))),
    });
  }
}

async function loadSheets() {
  if (!gasUrl()) return;
  setSync('busy');
  try {
    const r = await fetch(gasUrl() + '?api=data', { credentials: 'omit' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'error');
    mergeSheets(j.sheets || []);
    setSync('on');
  } catch (e) {
    console.warn(e);
    setSync('err', 'シート読込失敗: ' + e.message);
  }
}

// ---------- GAS (書き込み・同期) ----------
async function gas(fn, args = {}) {
  const r = await fetch(gasUrl(), {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn, passcode: state.settings.passcode || '', ...args }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'error');
  return j;
}

function setSync(s, msg) {
  state.sync = s;
  const b = $('#syncBadge');
  const label = { off: 'ローカル保存', busy: '同期中…', on: 'Google連携', err: '同期エラー' }[s];
  b.textContent = label;
  b.className = 'badge' + (s === 'on' ? ' on' : s === 'err' ? ' err' : '');
  b.title = msg || label;
}

let syncTimer = null;
function scheduleSync() {
  if (!canWrite()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncProgress, 4000);
}

async function syncProgress() {
  if (!canWrite()) return;
  const since = state.lastSync;
  const items = Object.fromEntries(Object.entries(state.progress).filter(([, p]) => (p.t || 0) > since));
  setSync('busy');
  try {
    const startedAt = Date.now();
    const j = await gas('syncProgress', { items });
    for (const [k, p] of Object.entries(j.items || {})) {
      const mine = state.progress[k];
      if (!mine || (p.t || 0) > (mine.t || 0)) state.progress[k] = p;
    }
    saveProgress();
    state.lastSync = startedAt;
    LS.set('qs.lastSync', startedAt);
    setSync('on');
  } catch (e) {
    console.warn(e);
    setSync('err', '進捗同期失敗: ' + e.message);
  }
}

// ---------- questions & progress ----------
function itemsFor(deck, quiz) {
  const rows = deck.rows.filter(r => usable(r[quiz.q]) && usable(r[quiz.a]));
  const byQ = {};
  for (const r of rows) (byQ[disp(r[quiz.q])] ||= []).push(r);
  return rows.map(r => ({
    key: `${deck.id}|${quiz.q}>${quiz.a}|${disp(r[quiz.q])}|${disp(r[quiz.a])}`,
    deck, quiz, row: r,
    correctRows: byQ[disp(r[quiz.q])],
  }));
}

function allItems(deck) { return deck.quizzes.flatMap(q => itemsFor(deck, q)); }

const isMastered = p => p && p.s >= 2;
const isWeak = p => p && p.w > 0 && p.s < 2;

function deckStats(deck) {
  const items = allItems(deck);
  let mastered = 0, weak = 0, seen = 0;
  for (const it of items) {
    const p = state.progress[it.key];
    if (p) seen++;
    if (isMastered(p)) mastered++; else if (isWeak(p)) weak++;
  }
  return { total: items.length, mastered, weak, seen };
}

function record(key, ok) {
  const p = state.progress[key] || { c: 0, w: 0, s: 0 };
  if (ok) { p.c++; p.s = (p.s || 0) + 1; } else { p.w++; p.s = 0; }
  p.t = Date.now();
  state.progress[key] = p;
  saveProgress();
  scheduleSync();
}

function weight(it) {
  const p = state.progress[it.key];
  if (!p) return 3;
  if (isMastered(p)) return 0.4;
  return 1 + 4 * (p.w / (p.c + p.w));
}

function sampleWeighted(items, n) {
  const pool = items.map(it => ({ it, k: Math.pow(Math.random(), 1 / Math.max(weight(it), 0.01)) }));
  pool.sort((a, b) => b.k - a.k);
  return pool.slice(0, n).map(x => x.it);
}

function choicesFor(it) {
  const { deck, quiz, row } = it;
  const correct = new Set(it.correctRows.map(r => disp(r[quiz.a])));
  const answer = disp(row[quiz.a]);
  let cands = uniq(deck.rows.filter(r => usable(r[quiz.a])).map(r => disp(r[quiz.a])).filter(v => !correct.has(v)));
  const y = yearNum(answer);
  if (y != null && cands.every(c => yearNum(c) != null)) {
    cands.sort((a, b) => Math.abs(yearNum(a) - y) - Math.abs(yearNum(b) - y));
    cands = shuffle(cands.slice(0, 8));
  } else if (deck.groupKey && deck.groupKey !== quiz.q && deck.groupKey !== quiz.a) {
    const g = disp(row[deck.groupKey]);
    const same = new Set(deck.rows.filter(r => disp(r[deck.groupKey]) === g).map(r => disp(r[quiz.a])));
    cands = [...shuffle(cands.filter(c => same.has(c))), ...shuffle(cands.filter(c => !same.has(c)))];
  } else {
    shuffle(cands);
  }
  return shuffle([answer, ...cands.slice(0, 3)]);
}

function checkTyped(it, input) {
  const n = norm(input);
  if (!n) return false;
  for (const r of it.correctRows) {
    for (const a of alts(r[it.quiz.a])) {
      if (norm(a) === n) return true;
      if (a.includes('、') && a.split('、').some(p => norm(p) === n)) return true;
    }
  }
  return false;
}

// ---------- session ----------
function startSession({ items, title, mode, back }) {
  if (!items.length) { toast('出題できる問題がありません'); return; }
  state.session = { items, title, mode, back, i: 0, results: [], answered: false };
  if (location.hash === '#/quiz') render(); else location.hash = '#/quiz';
}

function buildItems(pool, pick, count) {
  let items = pool;
  if (pick === 'weak') items = pool.filter(it => isWeak(state.progress[it.key]));
  else if (pick === 'new') items = pool.filter(it => !state.progress[it.key]);
  else if (pick === 'unmastered') items = pool.filter(it => !isMastered(state.progress[it.key]));
  if (pick === 'order') return count ? items.slice(0, count) : items;
  // 同じ問題文の重複（同年に複数受賞など）は1問にまとめる
  const seen = new Set();
  items = items.filter(it => { const k = it.key.split('|').slice(0, 3).join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
  return sampleWeighted(items, count || items.length);
}

// ---------- views ----------
const app = () => $('#app');

function viewHome() {
  const cats = {};
  for (const d of state.decks) (cats[d.category] ||= []).push(d);
  const weakItems = state.decks.flatMap(d => allItems(d)).filter(it => isWeak(state.progress[it.key]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayCount = Object.values(state.progress).filter(p => p.t >= today.getTime()).length;
  const mastered = Object.values(state.progress).filter(isMastered).length;

  app().innerHTML = `
    <div class="stat-row">
      <div class="card stat"><div class="v">${todayCount}</div><div class="k">今日学習した問題</div></div>
      <div class="card stat"><div class="v">${mastered}</div><div class="k">習得済み（2連続正解）</div></div>
      <div class="card stat"><div class="v">${weakItems.length}</div><div class="k">苦手な問題</div></div>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary" id="weakAll" ${weakItems.length ? '' : 'disabled'}>苦手をまとめて復習</button>
      <input type="search" id="gsearch" placeholder="全データを検索（例: ブータン、1185、芥川）" style="flex:1;min-width:200px">
    </div>
    <div id="gresults"></div>
    ${Object.entries(cats).map(([cat, decks]) => `
      <h2>${esc(cat)}</h2>
      <div class="grid">${decks.map(deckCard).join('')}</div>`).join('')}
  `;
  $('#weakAll').onclick = () => startSession({
    items: sampleWeighted(weakItems, 20), title: '苦手まとめ復習', mode: state.settings.quizMode || 'choice', back: '#/',
  });
  $('#gsearch').oninput = e => renderGlobalSearch(e.target.value);
}

function deckCard(d) {
  const st = deckStats(d);
  const pct = n => st.total ? (100 * n / st.total).toFixed(1) : 0;
  return `<a class="card deck-card" href="#/deck/${encodeURIComponent(d.id)}">
    <div class="title">${esc(d.title)}</div>
    <div class="meta">${d.rows.length}件 ・ 習得 ${st.mastered}/${st.total}${st.weak ? ` ・ 苦手 ${st.weak}` : ''}</div>
    <div class="bar"><div class="ok" style="width:${pct(st.mastered)}%"></div><div class="ng" style="width:${pct(st.weak)}%"></div></div>
  </a>`;
}

function renderGlobalSearch(q) {
  const box = $('#gresults');
  const n = norm(q);
  if (n.length < 1) { box.innerHTML = ''; return; }
  const hits = [];
  for (const d of state.decks) {
    for (const r of d.rows) {
      if (d.columns.some(c => c.type !== 'flag' && norm(r[c.key]).includes(n))) hits.push({ d, r });
      if (hits.length > 60) break;
    }
  }
  box.innerHTML = hits.length ? `<div class="card" style="margin-top:12px">${hits.slice(0, 60).map(({ d, r }) => `
    <div style="padding:6px 0;border-bottom:1px solid var(--border)">
      <a href="#/deck/${encodeURIComponent(d.id)}" class="small">${esc(d.title)}</a><br>
      ${d.columns.filter(c => c.key !== 'note' && r[c.key]).map(c => `<span class="muted small">${esc(c.label)}:</span> ${cellHtml(c, r[c.key])}`).join('　')}
    </div>`).join('')}</div>` : '<p class="muted">見つかりません</p>';
}

function deckHeader(d, tab) {
  const t = (k, label) => `<a href="#/deck/${encodeURIComponent(d.id)}/${k}" class="${tab === k ? 'active' : ''}">${label}</a>`;
  return `<div class="crumb"><a href="#/">ホーム</a> › ${esc(d.category)}</div>
    <h1>${esc(d.title)}</h1>
    ${d.description ? `<div class="muted small">${esc(d.description)}</div>` : ''}
    <nav class="tabs">${t('quiz', 'クイズ')}${t('list', '一覧表')}${t('flash', '暗記カード')}${t('stats', '成績')}</nav>`;
}

function viewDeck(id, tab = 'quiz') {
  const d = state.byId[id];
  if (!d) { app().innerHTML = '<p>デッキが見つかりません。<a href="#/">ホームへ</a></p>'; return; }
  ({ quiz: viewDeckQuiz, list: viewDeckList, flash: viewDeckFlash, stats: viewDeckStats }[tab] || viewDeckQuiz)(d);
}

function segHtml(name, options, value) {
  return `<div class="seg" data-name="${name}">${options.map(([v, l]) =>
    `<button type="button" data-v="${v}" class="${v === value ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function bindSeg(root, onChange) {
  root.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    onChange(seg.dataset.name, b.dataset.v);
  }));
}

function viewDeckQuiz(d) {
  const s = state.settings;
  const opt = { quiz: s['quiz.' + d.id] ?? '0', mode: s.quizMode || 'choice', pick: s.pick || 'normal', count: s.count || '10', group: '' };
  const groups = d.groupKey ? uniq(d.rows.map(r => disp(r[d.groupKey])).filter(Boolean)) : [];
  const groupLabel = d.groupKey && d.columns.find(c => c.key === d.groupKey).label;

  app().innerHTML = deckHeader(d, 'quiz') + (d.quizzes.length ? `
    <div class="card">
      <div class="field"><label>出題形式</label>
        ${segHtml('quiz', [...d.quizzes.map((q, i) => [String(i), esc(q.label)]), ['all', 'ミックス']], opt.quiz)}</div>
      <div class="field"><label>回答方法</label>
        ${segHtml('mode', [['choice', '4択'], ['type', '入力（みんはや形式）']], opt.mode)}</div>
      <div class="field"><label>出題範囲</label>
        ${segHtml('pick', [['normal', 'おまかせ（苦手優先）'], ['unmastered', '未習得'], ['new', '未出題'], ['weak', '苦手のみ'], ['order', '順番に全部']], opt.pick)}</div>
      ${groups.length > 1 ? `<div class="field"><label>${esc(groupLabel)}で絞り込み</label>
        <select id="groupSel"><option value="">すべて</option>${groups.map(g => `<option>${esc(g)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>問題数</label>
        ${segHtml('count', [['10', '10問'], ['20', '20問'], ['50', '50問'], ['0', '全部']], opt.count)}</div>
      <button class="btn primary" id="start">スタート</button>
      <span class="muted small" id="avail"></span>
    </div>` : '<p class="muted">このデッキにはクイズ設定がありません（列が2つ以上必要です）。</p>');
  if (!d.quizzes.length) return;

  const pool = () => {
    const qs = opt.quiz === 'all' ? d.quizzes : [d.quizzes[+opt.quiz] || d.quizzes[0]];
    let items = qs.flatMap(q => itemsFor(d, q));
    if (opt.group) items = items.filter(it => disp(it.row[d.groupKey]) === opt.group);
    return items;
  };
  const updateAvail = () => { $('#avail').textContent = ` 対象 ${buildItems(pool(), opt.pick, 0).length}問`; };
  bindSeg(app(), (name, v) => {
    opt[name] = v;
    if (name === 'quiz') s['quiz.' + d.id] = v; else if (name === 'mode') s.quizMode = v; else s[name] = v;
    saveSettings(); updateAvail();
  });
  if ($('#groupSel')) $('#groupSel').onchange = e => { opt.group = e.target.value; updateAvail(); };
  updateAvail();
  $('#start').onclick = () => startSession({
    items: buildItems(pool(), opt.pick, +opt.count), title: d.title, mode: opt.mode, back: `#/deck/${encodeURIComponent(d.id)}/quiz`,
  });
}

function viewDeckList(d) {
  const cols = d.columns;
  const hidden = new Set();
  app().innerHTML = deckHeader(d, 'list') + `
    <div class="row" style="margin-bottom:10px">
      <input type="search" id="filter" placeholder="絞り込み" style="flex:1;min-width:160px">
      <select id="hideSel" style="width:auto"><option value="">列を隠して暗記…</option>
        ${cols.filter(c => c.key !== 'note').map(c => `<option value="${c.key}">「${esc(c.label)}」を隠す</option>`).join('')}</select>
      ${canWrite() ? '<button class="btn small" id="addRow">＋ 追加</button>' : ''}
    </div>
    <div class="table-wrap"><table>
      <thead><tr>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody id="tbody"></tbody></table></div>
    <p class="muted small">${d.rows.length}件${d.rows.some(r => r._src === 'sheet') ? '　左端に色の線がある行はスプレッドシートから追加した行' : ''}</p>`;

  const draw = () => {
    const n = norm($('#filter').value);
    const rows = n ? d.rows.filter(r => cols.some(c => norm(r[c.key]).includes(n))) : d.rows;
    $('#tbody').innerHTML = rows.map(r => `<tr class="${r._src === 'sheet' ? 'src-sheet' : ''}">${cols.map(c =>
      hidden.has(c.key)
        ? `<td class="hid" data-k="${c.key}"><button class="btn small">？</button><span hidden>${cellHtml(c, r[c.key])}</span></td>`
        : `<td class="${c.key === 'note' ? 'note' : ''}">${cellHtml(c, r[c.key])}</td>`).join('')}</tr>`).join('');
  };
  $('#filter').oninput = draw;
  $('#hideSel').onchange = e => { hidden.clear(); if (e.target.value) hidden.add(e.target.value); draw(); };
  $('#tbody').onclick = e => {
    const td = e.target.closest('td.hid'); if (!td) return;
    td.querySelector('button').hidden = true; td.querySelector('span').hidden = false;
  };
  if ($('#addRow')) $('#addRow').onclick = () => addRowDialog(d, () => viewDeckList(d));
  draw();
}

function addRowDialog(d, done) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog">
    <h2 style="margin-top:0">「${esc(d.title)}」に追加</h2>
    <p class="muted small">Googleスプレッドシートに保存されます。別解は | 区切り、列挙は 、区切り。</p>
    ${d.columns.map(c => `<div class="field"><label>${esc(c.label)}${c.type === 'flag' ? '（ISOコード 例: jp）' : ''}</label>
      <input type="text" name="${c.key}"></div>`).join('')}
    <div class="row"><button class="btn primary" value="ok">保存</button><button class="btn" value="cancel" formnovalidate>キャンセル</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    const fd = new FormData(dlg.querySelector('form'));
    dlg.remove();
    if (dlg.returnValue !== 'ok') return;
    const row = Object.fromEntries(d.columns.map(c => [c.key, String(fd.get(c.key) || '').trim()]));
    if (!Object.values(row).some(Boolean)) return;
    try {
      const values = {};
      d.columns.forEach(c => { values[c.key] = row[c.key]; values[c.label] = row[c.key]; });
      await gas('addRow', {
        sheet: d._fromSheet ? d._sheetName : d.id,
        header: d._fromSheet ? null : d.columns.map(c => c.key),
        values,
      });
      d.rows.push({ ...row, _src: 'sheet' });
      toast('追加しました');
      done();
    } catch (e) { toast('追加に失敗: ' + e.message, 4000); }
  });
}

function viewDeckFlash(d) {
  let qi = +(state.settings['quiz.' + d.id] ?? 0) || 0;
  let cards = [], i = 0, flipped = false;
  const reset = () => {
    cards = shuffle(itemsFor(d, d.quizzes[qi]).filter(it => !isMastered(state.progress[it.key])));
    if (!cards.length) cards = shuffle(itemsFor(d, d.quizzes[qi]));
    i = 0; flipped = false;
  };
  app().innerHTML = deckHeader(d, 'flash') + (d.quizzes.length ? `
    <div class="field">${segHtml('quiz', d.quizzes.map((q, i) => [String(i), esc(q.label)]), String(qi))}</div>
    <div id="flashArea"></div>` : '<p class="muted">カードにできる列がありません。</p>');
  if (!d.quizzes.length) return;
  reset();
  const draw = () => {
    const it = cards[i];
    if (!it) { $('#flashArea').innerHTML = '<div class="card center">一巡しました。<br><button class="btn" id="again" style="margin-top:8px">もう一度</button></div>'; $('#again').onclick = () => { reset(); draw(); }; return; }
    const qc = d.columns.find(c => c.key === it.quiz.q), ac = d.columns.find(c => c.key === it.quiz.a);
    const front = qc.type === 'flag' ? flagImg(it.row[qc.key], 'big') : esc(disp(it.row[qc.key]));
    const back = it.correctRows.map(r => ac.type === 'flag' ? flagImg(r[ac.key], 'mid') : cellHtml(ac, r[ac.key])).join('<br>');
    $('#flashArea').innerHTML = `
      <div class="muted small center">${i + 1} / ${cards.length}</div>
      <div class="card flash" id="card">
        <div class="front">${front}</div>
        ${flipped ? `<div class="back">${back}</div>${it.row.note ? `<div class="muted small">${esc(it.row.note)}</div>` : ''}` : '<div class="hint">タップ / Space で答えを表示</div>'}
      </div>
      <div class="row" style="justify-content:center;margin-top:12px">
        <button class="btn" id="ng" ${flipped ? '' : 'disabled'}>まだ <kbd>←</kbd></button>
        <button class="btn primary" id="ok" ${flipped ? '' : 'disabled'}>覚えた <kbd>→</kbd></button>
      </div>`;
    $('#card').onclick = () => { flipped = !flipped; draw(); };
    $('#ok').onclick = () => next(true);
    $('#ng').onclick = () => next(false);
  };
  const next = ok => { record(cards[i].key, ok); if (!ok) cards.push(cards[i]); i++; flipped = false; draw(); };
  bindSeg(app(), (_, v) => { qi = +v; state.settings['quiz.' + d.id] = v; saveSettings(); reset(); draw(); });
  keyHandler = e => {
    if (e.key === ' ') { e.preventDefault(); flipped = !flipped; draw(); }
    else if (flipped && e.key === 'ArrowRight') next(true);
    else if (flipped && e.key === 'ArrowLeft') next(false);
  };
  draw();
}

function viewDeckStats(d) {
  const rows = d.quizzes.map(q => {
    const items = itemsFor(d, q);
    const ps = items.map(it => state.progress[it.key]).filter(Boolean);
    const c = ps.reduce((a, p) => a + p.c, 0), w = ps.reduce((a, p) => a + p.w, 0);
    return { q, total: items.length, mastered: ps.filter(isMastered).length, rate: c + w ? Math.round(100 * c / (c + w)) : null };
  });
  const weak = allItems(d).filter(it => isWeak(state.progress[it.key]))
    .sort((a, b) => state.progress[b.key].w - state.progress[a.key].w).slice(0, 40);
  app().innerHTML = deckHeader(d, 'stats') + `
    <div class="table-wrap"><table>
      <thead><tr><th>形式</th><th>習得</th><th>正答率</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(r.q.label)}</td><td>${r.mastered} / ${r.total}</td><td>${r.rate == null ? '—' : r.rate + '%'}</td></tr>`).join('')}</tbody>
    </table></div>
    <h2>苦手な問題</h2>
    ${weak.length ? `<div class="table-wrap"><table><thead><tr><th>問題</th><th>答え</th><th>誤答</th></tr></thead><tbody>
      ${weak.map(it => `<tr><td>${cellHtml(d.columns.find(c => c.key === it.quiz.q), it.row[it.quiz.q])}</td>
        <td>${cellHtml(d.columns.find(c => c.key === it.quiz.a), it.row[it.quiz.a])}</td><td>${state.progress[it.key].w}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">まだありません</p>'}`;
}

// ---------- quiz screen ----------
let keyHandler = null;

function viewQuiz() {
  const S = state.session;
  if (!S) { location.hash = '#/'; return; }
  if (S.i >= S.items.length) return viewResult();
  const it = S.items[S.i];
  const { deck, quiz, row } = it;
  const qc = deck.columns.find(c => c.key === quiz.q), ac = deck.columns.find(c => c.key === quiz.a);
  const qVal = disp(row[quiz.q]);
  const answerText = disp(row[quiz.a]);
  const typing = S.mode === 'type' && ac.type !== 'flag' && answerText.length <= 16;
  if (!S.choices || S.choicesFor !== S.i) { S.choices = typing ? null : choicesFor(it); S.choicesFor = S.i; }

  const qHtml = qc.type === 'flag' ? flagImg(row[quiz.q], 'big') : esc(qVal);
  const longQ = qVal.length > 24;

  app().innerHTML = `<div class="quiz">
    <div class="qhead"><span>${esc(S.title)}</span><span>${S.i + 1} / ${S.items.length}</span></div>
    <div class="progress"><div style="width:${100 * S.i / S.items.length}%"></div></div>
    <div class="qlabel">${esc(quiz.label)}${S.title !== deck.title ? ` ・ ${esc(deck.title)}` : ''}</div>
    <div class="qtext ${longQ ? 'long' : ''}">${qHtml}</div>
    ${typing ? `
      <form class="answer-input" id="typeForm" autocomplete="off">
        <input type="text" id="typed" placeholder="${esc(ac.label)}を入力" autocapitalize="off" autocorrect="off" spellcheck="false" ${S.answered ? 'disabled' : ''}>
        <button class="btn primary" ${S.answered ? 'disabled' : ''}>回答</button>
      </form>
      ${S.answered ? '' : '<div class="row" style="margin-top:8px"><button class="btn small" id="giveup">わからない</button></div>'}`
    : `<div class="choices ${ac.type === 'flag' ? 'flags' : ''}">${S.choices.map((c, i) => `
        <button class="choice" data-v="${esc(c)}"><span class="num">${i + 1}</span>${ac.type === 'flag' ? flagImg(c, 'mid') : esc(c)}</button>`).join('')}</div>`}
    <div id="fb"></div>
  </div>`;

  const correctSet = new Set(it.correctRows.map(r => disp(r[quiz.a])));
  const answer = (ok, given) => {
    if (S.answered) return;
    S.answered = true;
    record(it.key, ok);
    S.results.push({ it, ok, given });
    showFeedback(it, ok);
    if (!typing) {
      app().querySelectorAll('.choice').forEach(b => {
        b.disabled = true;
        if (correctSet.has(b.dataset.v)) b.classList.add('correct');
        else if (b.dataset.v === given) b.classList.add('wrong');
      });
    } else {
      $('#typed').disabled = true;
      $('#typeForm button').disabled = true;
      $('#giveup')?.remove();
    }
  };

  if (typing) {
    const inp = $('#typed');
    if (!S.answered) inp.focus();
    $('#typeForm').onsubmit = e => { e.preventDefault(); if (inp.value.trim()) answer(checkTyped(it, inp.value), inp.value); };
    $('#giveup')?.addEventListener('click', () => answer(false, ''));
  } else {
    app().querySelectorAll('.choice').forEach(b => b.onclick = () => answer(correctSet.has(b.dataset.v), b.dataset.v));
  }

  keyHandler = e => {
    if (e.isComposing) return;
    if (S.answered && e.key === 'Enter') { if (e.target.tagName === 'BUTTON') return; e.preventDefault(); nextQ(); return; }
    if (!S.answered && !typing && /^[1-4]$/.test(e.key)) app().querySelectorAll('.choice')[+e.key - 1]?.click();
  };
}

function showFeedback(it, ok) {
  const S = state.session;
  const { deck, quiz, row } = it;
  const ac = deck.columns.find(c => c.key === quiz.a);
  const answers = it.correctRows.map(r => ac.type === 'flag' ? flagImg(r[ac.key], 'mid') : cellHtml(ac, r[ac.key])).join('　/　');
  const details = deck.columns.filter(c => c.key !== quiz.q && c.key !== quiz.a && c.key !== 'note' && row[c.key])
    .map(c => `<span class="muted small">${esc(c.label)}:</span> ${cellHtml(c, row[c.key])}`).join('　');
  $('#fb').innerHTML = `<div class="feedback ${ok ? 'ok' : 'ng'}">
    <div class="verdict">${ok ? '⭕ 正解' : '❌ 不正解'}</div>
    <div>答え：<b>${answers}</b></div>
    ${details ? `<div style="margin-top:4px">${details}</div>` : ''}
    ${row.note ? `<div class="muted small" style="margin-top:4px">💡 ${esc(row.note)}</div>` : ''}
  </div>
  <div class="row" style="margin-top:12px">
    <button class="btn primary" id="next">次へ <kbd>Enter</kbd></button>
    ${!ok && S.mode === 'type' ? '<button class="btn small" id="override">表記ゆれ（正解にする）</button>' : ''}
  </div>`;
  $('#next').onclick = nextQ;
  $('#next').focus();
  $('#override')?.addEventListener('click', () => {
    const p = state.progress[it.key];
    p.w = Math.max(0, p.w - 1); p.c++; p.s = 1; p.t = Date.now();
    saveProgress(); scheduleSync();
    S.results[S.results.length - 1].ok = true;
    nextQ();
  });
}

function nextQ() {
  const S = state.session;
  S.i++; S.answered = false;
  render();
}

function viewResult() {
  const S = state.session;
  const ok = S.results.filter(r => r.ok).length;
  const wrong = S.results.filter(r => !r.ok);
  syncProgress();
  app().innerHTML = `<div class="quiz">
    <h1>結果</h1>
    <div class="card center"><div style="font-size:2.4rem;font-weight:700">${ok} / ${S.results.length}</div>
      <div class="muted">正答率 ${S.results.length ? Math.round(100 * ok / S.results.length) : 0}%</div></div>
    <div class="row" style="margin-top:14px">
      ${wrong.length ? '<button class="btn primary" id="retry">間違えた問題をもう一度</button>' : ''}
      <a class="btn" href="${S.back}">戻る</a>
    </div>
    ${wrong.length ? `<h2>間違えた問題</h2><div class="table-wrap"><table><thead><tr><th>問題</th><th>正解</th><th>あなたの回答</th></tr></thead><tbody>
      ${wrong.map(({ it, given }) => {
        const qc = it.deck.columns.find(c => c.key === it.quiz.q), ac = it.deck.columns.find(c => c.key === it.quiz.a);
        return `<tr><td>${cellHtml(qc, it.row[it.quiz.q])}</td><td>${cellHtml(ac, it.row[it.quiz.a])}</td><td>${ac.type === 'flag' ? flagImg(given) : esc(given)}</td></tr>`;
      }).join('')}</tbody></table></div>` : ''}
  </div>`;
  $('#retry')?.addEventListener('click', () => startSession({ ...S, items: shuffle(wrong.map(r => r.it)) }));
}

// ---------- settings ----------
function viewSettings() {
  const s = state.settings;
  const n = Object.keys(state.progress).length;
  app().innerHTML = `
    <div class="crumb"><a href="#/">ホーム</a></div>
    <h1>設定・連携</h1>
    <div class="card">
      <h2 style="margin-top:0">Google スプレッドシート連携</h2>
      <p class="small muted">GAS ウェブアプリの URL と、スクリプトプロパティ <code>PASSCODE</code> に設定した合言葉を入力すると、
        スプレッドシートの追加データ読込・アプリからの行追加・学習記録の端末間同期が有効になります。</p>
      <div class="field"><label>GAS ウェブアプリ URL（/exec）</label>
        <input type="url" id="gasUrl" value="${esc(s.gasUrl || '')}" placeholder="${esc(CFG.GAS_URL || 'https://script.google.com/macros/s/…/exec')}"></div>
      <div class="field"><label>合言葉（この端末にのみ保存）</label>
        <input type="password" id="pass" value="${esc(s.passcode || '')}" autocomplete="off"></div>
      <div class="row">
        <button class="btn primary" id="saveConn">保存して接続テスト</button>
        <button class="btn" id="syncNow" ${canWrite() ? '' : 'disabled'}>今すぐ同期</button>
      </div>
      <p class="small" id="connMsg"></p>
    </div>

    <div class="card" style="margin-top:12px">
      <h2 style="margin-top:0">新しいデッキを作る</h2>
      <p class="small muted">スプレッドシートに新しいシートを作ります。シート名は「カテゴリ/タイトル」、1行目が見出し、1列目が問題の軸になります（列名「補足」は解説扱い、「国旗」を含む列は国旗表示）。スプレッドシートで直接シートを追加しても同じです。</p>
      <div class="field"><label>カテゴリ</label><input type="text" id="ndCat" placeholder="例: 地理"></div>
      <div class="field"><label>タイトル</label><input type="text" id="ndTitle" placeholder="例: 日本の都道府県"></div>
      <div class="field"><label>列名（、区切り）</label><input type="text" id="ndCols" placeholder="例: 都道府県、県庁所在地、名産、補足"></div>
      <button class="btn" id="newDeck" ${canWrite() ? '' : 'disabled'}>作成</button>
    </div>

    <div class="card" style="margin-top:12px">
      <h2 style="margin-top:0">学習記録</h2>
      <p class="small muted">${n}問分の記録がこの端末にあります。</p>
      <div class="row">
        <button class="btn" id="exportP">書き出し（JSON）</button>
        <label class="btn">読み込み<input type="file" id="importP" accept="application/json" hidden></label>
        <button class="btn" id="resetP">この端末の記録をリセット</button>
      </div>
    </div>
    <p class="small muted">基本データは GitHub リポジトリの <code>data/</code> フォルダの JSON で管理しています（形式は data/SCHEMA.md）。</p>`;

  $('#saveConn').onclick = async () => {
    s.gasUrl = $('#gasUrl').value.trim();
    s.passcode = $('#pass').value;
    saveSettings();
    const msg = $('#connMsg');
    if (!gasUrl()) { msg.textContent = '連携なし（ローカル保存）'; setSync('off'); return; }
    msg.textContent = '接続中…';
    try {
      await loadSheets();
      if (state.sync === 'err') throw new Error($('#syncBadge').title);
      if (s.passcode) { await gas('ping'); await syncProgress(); }
      msg.textContent = s.passcode ? '✅ 接続OK（読み書き・同期できます）' : '✅ 読み込みOK（合言葉を入れると書き込み・同期ができます）';
      viewSettings();
      $('#connMsg').textContent = msg.textContent;
    } catch (e) { msg.textContent = '❌ ' + e.message; }
  };
  $('#syncNow').onclick = async () => { await loadSheets(); await syncProgress(); toast(state.sync === 'on' ? '同期しました' : '同期に失敗しました'); };
  $('#newDeck').onclick = async () => {
    const cat = $('#ndCat').value.trim(), title = $('#ndTitle').value.trim();
    const cols = $('#ndCols').value.split(/[、,]/).map(x => x.trim()).filter(Boolean);
    if (!title || cols.length < 2) { toast('タイトルと2つ以上の列名が必要です'); return; }
    const name = (cat ? cat + '/' : '') + title;
    try {
      await gas('addRow', { sheet: name, header: cols, values: null });
      await loadSheets();
      toast('作成しました');
      location.hash = '#/deck/' + encodeURIComponent('sheet-' + name) + '/list';
    } catch (e) { toast('作成に失敗: ' + e.message, 4000); }
  };
  $('#exportP').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state.progress)], { type: 'application/json' }));
    a.download = `quiz-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('#importP').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      for (const [k, p] of Object.entries(data)) {
        if (!state.progress[k] || (p.t || 0) > (state.progress[k].t || 0)) state.progress[k] = p;
      }
      saveProgress(); scheduleSync(); toast('読み込みました'); viewSettings();
    } catch { toast('読み込めませんでした'); }
  };
  $('#resetP').onclick = () => {
    if (!confirm('この端末の学習記録を消去しますか？（Google 側の記録は残ります）')) return;
    state.progress = {}; state.lastSync = 0; saveProgress(); LS.set('qs.lastSync', 0); viewSettings();
  };
}

// ---------- router ----------
function render() {
  keyHandler = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (parts[0] === 'deck') viewDeck(parts[1], parts[2]);
  else if (parts[0] === 'quiz') viewQuiz();
  else if (parts[0] === 'settings') viewSettings();
  else viewHome();
}

document.addEventListener('keydown', e => {
  if (!keyHandler) return;
  if (e.target.matches('input, select, textarea') && e.key !== 'Enter') return;
  keyHandler(e);
});
window.addEventListener('hashchange', render);

(async function init() {
  setSync(gasUrl() ? 'busy' : 'off');
  try { await loadBase(); } catch (e) { app().innerHTML = `<p>データの読み込みに失敗しました: ${esc(e.message)}</p>`; return; }
  render();
  if (gasUrl()) {
    await loadSheets();
    if (!location.hash.startsWith('#/quiz')) render();
    syncProgress();
  }
})();
