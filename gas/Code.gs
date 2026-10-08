/**
 * クイズ勉強帳 — Google スプレッドシート連携 API
 *
 * スクリプトプロパティ:
 *   SPREADSHEET_ID … setup() 実行で自動作成・設定
 *   PASSCODE       … 書き込み・学習記録同期用の合言葉（自分で設定）
 *
 * シートの扱い:
 *   名前が "_" で始まるシート … システム用（_progress = 学習記録、_使い方）
 *   名前がデッキID（例 award-akutagawa） … 既存デッキへの追加行。1行目は列キーまたは列名
 *   名前が「カテゴリ/タイトル」 … 新しいデッキ。1行目が見出し
 */

const PROGRESS_SHEET = '_progress';
const PROGRESS_HEADER = ['key', 'c', 'w', 's', 't'];

function props_() { return PropertiesService.getScriptProperties(); }

function ss_() {
  const id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID 未設定です。setup() を実行してください');
  return SpreadsheetApp.openById(id);
}

/** 初回のみエディタから実行：スプレッドシートを作成して ID を保存 */
function setup() {
  let id = props_().getProperty('SPREADSHEET_ID');
  if (!id) {
    const ss = SpreadsheetApp.create('クイズ勉強帳データ');
    id = ss.getId();
    props_().setProperty('SPREADSHEET_ID', id);
    const help = ss.getSheets()[0].setName('_使い方');
    help.getRange(1, 1, 6, 1).setValues([
      ['このスプレッドシートはクイズ勉強帳アプリのデータです。'],
      ['・既存デッキに行を足す: シート名をデッキID（例 award-akutagawa）にし、1行目に列キー（year, winner, work, note など）を書く'],
      ['・新しいデッキを作る: シート名を「カテゴリ/タイトル」（例 地理/日本の都道府県）にし、1行目に見出しを書く。1列目が問題の軸'],
      ['・別解は | 区切り、列挙は 、区切り。見出し「補足」は解説、「国旗」を含む列は ISO コード（jp など）で国旗表示'],
      ['・_ で始まるシートはシステム用（_progress = 学習記録）'],
      ['・アプリの「＋追加」「新しいデッキを作る」からも書き込めます'],
    ]);
  }
  Logger.log('SPREADSHEET_ID = ' + id);
  Logger.log('URL = ' + SpreadsheetApp.openById(id).getUrl());
  if (!props_().getProperty('PASSCODE')) Logger.log('⚠ スクリプトプロパティ PASSCODE を設定してください');
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.api === 'data') return json_({ ok: true, sheets: readSheets_() });
    return json_({ ok: true, app: 'quiz-study' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const pass = props_().getProperty('PASSCODE');
    if (!pass) throw new Error('PASSCODE が未設定です');
    if (body.passcode !== pass) throw new Error('合言葉が違います');
    switch (body.fn) {
      case 'ping': return json_({ ok: true });
      case 'addRow': return json_({ ok: true, result: addRow_(body.sheet, body.header, body.values) });
      case 'syncProgress': return json_({ ok: true, items: syncProgress_(body.items || {}) });
      default: throw new Error('unknown fn: ' + body.fn);
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function readSheets_() {
  return ss_().getSheets()
    .filter(sh => !sh.getName().startsWith('_') && sh.getLastRow() >= 1 && sh.getLastColumn() >= 1)
    .map(sh => {
      const v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
      return { name: sh.getName(), header: v[0], rows: v.slice(1) };
    });
}

/**
 * 行を追加。シートがなければ header で作成する。
 * values は {列キー or 列名: 値}。null ならシート作成のみ。
 */
function addRow_(name, header, values) {
  name = String(name || '').trim();
  if (!name || name.startsWith('_')) throw new Error('シート名が不正です');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = ss_();
    let sh = ss.getSheetByName(name);
    if (!sh) {
      if (!header || !header.length) throw new Error('見出しがありません');
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    if (!values) return 'created';
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    // 数値や日付に自動変換されないよう文字列として書く
    const row = head.map(h => {
      const v = values[String(h).trim()];
      return v == null ? '' : String(v);
    });
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    return 'added';
  } finally {
    lock.releaseLock();
  }
}

/** 端末から来た記録をマージ（新しい t が勝つ）し、全記録を返す */
function syncProgress_(items) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = ss_();
    let sh = ss.getSheetByName(PROGRESS_SHEET);
    if (!sh) {
      sh = ss.insertSheet(PROGRESS_SHEET);
      sh.getRange(1, 1, 1, PROGRESS_HEADER.length).setValues([PROGRESS_HEADER]);
      sh.setFrozenRows(1);
    }
    const map = {};
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(r => {
        if (r[0]) map[r[0]] = { c: +r[1], w: +r[2], s: +r[3], t: +r[4] };
      });
    }
    let changed = false;
    Object.keys(items).forEach(k => {
      const p = items[k];
      if (!map[k] || (+p.t || 0) > map[k].t) {
        map[k] = { c: +p.c || 0, w: +p.w || 0, s: +p.s || 0, t: +p.t || 0 };
        changed = true;
      }
    });
    if (changed) {
      const rows = Object.keys(map).map(k => [k, map[k].c, map[k].w, map[k].s, map[k].t]);
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 5).clearContent();
      sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
      sh.getRange(2, 1, rows.length, 5).setValues(rows);
    }
    return map;
  } finally {
    lock.releaseLock();
  }
}
