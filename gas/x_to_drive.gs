/**
 * X（Twitter）のポストの画像・動画を、アカウントごとの Google ドライブのフォルダに保存する
 * （同じフォルダ内では重複したものは保存しない）
 *
 *   Xアカウント「あ」 → ドライブのフォルダ「あ」
 *   Xアカウント「い」 → ドライブのフォルダ「い」
 *
 * ■ accounts シート（アカウントとフォルダの対応表）
 *   A列: Xのアカウント名（@なし）
 *   B列: 保存先フォルダのID … 空でOK。空ならアカウント名のフォルダを自動で作る
 *        （同じ名前のフォルダが既にあればそれを使う）
 *   C列: ☑ 全投稿を取得 … チェックしたアカウントは公式APIで過去の投稿を遡って保存し、
 *        以降は新しい投稿だけ自動保存（公式APIは有料）
 *   D〜F列: フォルダのリンク・状況・最終実行（自動で入る）
 *
 * ■ 設定 シート
 *   遡る投稿数、画像・動画付きだけ読むか、などをここで変更できる（コードを触る必要はない）
 *
 * ■ URLs シート（無料で使える方法）
 *   A列にポストURLを貼る → 投稿者のフォルダに保存
 *   accounts シートにないアカウントは、自動で行とフォルダが追加される
 *   ※ 非公式API（api.fxtwitter.com）を使用。仕様変更で動かなくなる可能性あり
 *
 * ■ 重複チェック（フォルダごと）
 *   1. 同じ画像・動画のIDが保存済みならダウンロードしない
 *   2. ダウンロード後、中身のハッシュ（MD5）が同じファイルがあれば保存しない
 *      → 同じアカウントが同じ画像を上げ直していても1つだけ保存される
 *   記録は log シートに残る（消すと重複チェックがリセットされる）
 *
 * ■ セットアップ
 *   1. 新しいGoogleスプレッドシートを作る →「拡張機能」→「Apps Script」
 *   2. このコードを全部貼り付けて保存
 *   3. スプレッドシートを再読み込み → メニュー「X→Drive」→「初期設定」（権限を許可）
 *   4. accounts シートのA列にアカウント名を書く → メニュー「初期設定」をもう一度（フォルダが作られる）
 *   5. 全投稿取得を使う場合のみ: Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」に
 *      X_BEARER_TOKEN = （X Developer Portal で発行した Bearer Token）を追加し、C列をチェック
 *   6. 自動化したい場合はメニュー「1時間ごとの自動実行をON」
 *
 * ■ 大きい動画（50MB超）
 *   Apps Script では受け取れないので「大きい動画」シートに入れ、GitHub Actions の Python（x-uploader の x2drive.py）が保存する
 *   設定はメニュー「X→Drive」→「大きい動画（50MB超）」から（ファイルの一番下に説明あり）
 *
 * ■ 制限
 *   - 1回の実行は約5分で区切り、続きは次回実行で再開します
 */

/**
 * 設定は「設定」シートで変更する（ここに書いてあるのは初期値。コードを触る必要はない）
 * [キー, シートに表示する項目名, 初期値, 種類, 説明]
 */
const SETTINGS_DEF = [
  ['MEDIA_ONLY', '画像・動画付きの投稿だけ読む', true, 'bool',
    'ON：画像・動画付きの投稿だけ読む（文字だけの投稿に料金がかからない）／OFF：全部の投稿を読む'],
  ['MAX_PAST_POSTS', '過去に遡る投稿数', 100, 'num',
    '最初に遡る件数。0で上限なし。増やすと次回の実行で足りない分を取り直す。新しい投稿はこの数に関係なく毎回保存'],
  ['INCLUDE_REPLIES', '返信の画像も保存する', true, 'bool', '自分の投稿への返信などに付いた画像も対象にする'],
  ['INCLUDE_RETWEETS', 'リポストも保存する', false, 'bool', '他人の投稿をリポストしたものも対象にする'],
  ['SUBFOLDER_PER_POST', 'ポストごとにフォルダを分ける', false, 'bool', 'ON：アカウントのフォルダの中に、さらにポストごとのフォルダを作る'],
  ['PARENT_FOLDER_ID', 'フォルダを作る場所（親フォルダのID）', '', 'str',
    '空ならマイドライブ直下。まとめたいフォルダがあれば、そのURLの folders/ の後ろの部分を貼る'],
];

const CONFIG = { MAX_RUNTIME_MS: 5 * 60 * 1000 };
SETTINGS_DEF.forEach(([key, , def]) => { CONFIG[key] = def; });

const SHEET_SETTINGS = '設定';
const SHEET_ACCOUNTS = 'accounts';
const SHEET_URLS = 'URLs';
const SHEET_LOG = 'log';
const ACCOUNTS_HEADER = ['account（@なし）', 'folder_id（空なら自動作成）', '全投稿を取得（公式API）', 'folder_url', 'status', 'last_run'];
const URLS_HEADER = ['post_url', 'status', 'processed_at'];
const LOG_HEADER = ['media_key', 'post_id', 'post_url', 'type', 'file_name', 'md5', 'drive_file_id', 'saved_at', 'account', 'folder_id'];

/* ===================== メニュー ===================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('X→Drive')
    .addItem('初期設定（シート・フォルダ作成）', 'setup')
    .addSeparator()
    .addItem('URLリストを処理', 'processUrlList')
    .addItem('チェックしたアカウントの投稿を取得（公式API）', 'syncFromApi')
    .addSeparator()
    .addItem('各フォルダの既存ファイルを重複チェックに登録', 'indexExistingFiles')
    .addItem('1時間ごとの自動実行をON', 'installTrigger')
    .addItem('自動実行をOFF', 'removeTrigger')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('大きい動画（50MB超）')
      .addItem('① GitHub連携を登録', 'bigSaveGithub')
      .addItem('② Python用の合言葉とURLを表示', 'bigShowKey')
      .addItem('【テスト】GitHubを起動できるか確認', 'bigTestDispatch')
      .addItem('待ちの動画を今すぐ保存する', 'bigDispatchNow')
      .addItem('失敗した動画をやり直す', 'bigRetryFailed'))
    .addToUi();
  try { ensureSettingsSheet_(); } catch (e) { /* 権限前などは「初期設定」で作られる */ }
}

/* ===================== 設定シート ===================== */

/** 設定シートを作る（足りない項目は追加）。C列は内部用のキー（非表示） */
function ensureSettingsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_SETTINGS, 0);
    sh.appendRow(['項目', '値', 'key', '説明']);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, 4).setFontWeight('bold');
    sh.setColumnWidth(1, 260);
    sh.setColumnWidth(2, 120);
    sh.setColumnWidth(4, 520);
  }
  const last = sh.getLastRow();
  const existing = last > 1 ? sh.getRange(2, 3, last - 1, 1).getValues().map(r => String(r[0])) : [];
  SETTINGS_DEF.forEach(([key, label, def, type, desc]) => {
    if (existing.includes(key)) return;
    sh.appendRow([label, def, key, desc]);
    if (type === 'bool') sh.getRange(sh.getLastRow(), 2).insertCheckboxes().setValue(def);
  });
  sh.hideColumns(3);
  return sh;
}

/** 設定シートの値を CONFIG に読み込む（シートがなければ初期値のまま） */
function loadSettings_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SETTINGS);
  if (!sh || sh.getLastRow() < 2) return;
  const types = {};
  SETTINGS_DEF.forEach(([key, , , type]) => { types[key] = type; });
  sh.getRange(2, 2, sh.getLastRow() - 1, 2).getValues().forEach(([value, key]) => {
    const type = types[key];
    if (!type) return;
    if (type === 'bool') CONFIG[key] = value === true || String(value).toUpperCase() === 'TRUE';
    else if (type === 'num') { const n = parseInt(value, 10); CONFIG[key] = isNaN(n) || n < 0 ? 0 : n; }
    else CONFIG[key] = String(value || '').trim();
  });
}

function setup() {
  ensureSettingsSheet_();
  loadSettings_();
  const sh = getSheet_(SHEET_ACCOUNTS, ACCOUNTS_HEADER);
  sh.getRange(2, 3, 300, 1).insertCheckboxes();
  getSheet_(SHEET_URLS, URLS_HEADER);
  getSheet_(SHEET_LOG, LOG_HEADER);

  const acc = loadAccounts_();
  acc.list.forEach(a => ensureFolder_(acc.sh, a));
  SpreadsheetApp.getActive().toast(
    acc.list.length
      ? `${acc.list.length}アカウント分のフォルダを準備しました`
      : 'accounts シートのA列にアカウント名を書いて、もう一度「初期設定」を実行してください'
  );
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('runAll').timeBased().everyHours(1).create();
  SpreadsheetApp.getActive().toast('1時間ごとの自動実行をONにしました');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runAll')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** 自動実行の本体：URLリスト → チェックしたアカウント（トークンがあれば）の順に処理 */
function runAll() {
  loadSettings_();
  const deadline = Date.now() + CONFIG.MAX_RUNTIME_MS;
  processUrlList_(deadline);
  if (getBearerToken_()) syncAllAccounts_(deadline);
  bigDispatchIfNeeded_();
}

function processUrlList() { loadSettings_(); processUrlList_(Date.now() + CONFIG.MAX_RUNTIME_MS); bigDispatchIfNeeded_(); }
function syncFromApi() { loadSettings_(); syncAllAccounts_(Date.now() + CONFIG.MAX_RUNTIME_MS); bigDispatchIfNeeded_(); }

/* ===================== アカウント ↔ フォルダ ===================== */

function normName_(s) {
  return String(s || '').trim().replace(/^@/, '');
}

function loadAccounts_() {
  const sh = getSheet_(SHEET_ACCOUNTS, ACCOUNTS_HEADER);
  const list = [];
  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, ACCOUNTS_HEADER.length).getValues().forEach((r, i) => {
      const name = normName_(r[0]);
      if (!name) return;
      list.push({
        row: i + 2,
        name,
        folderId: String(r[1] || '').trim(),
        api: r[2] === true || String(r[2]).toUpperCase() === 'TRUE',
        lastRun: r[5] instanceof Date ? r[5].getTime() : 0,
      });
    });
  }
  return { sh, list };
}

/** アカウントのフォルダを返す。B列が空なら同名フォルダを探す／なければ作ってIDを書き込む */
function ensureFolder_(sh, a) {
  let folder;
  if (a.folderId) {
    folder = DriveApp.getFolderById(a.folderId);
  } else {
    folder = getOrCreateSubfolder_(getParentFolder_(), a.name);
    a.folderId = folder.getId();
    sh.getRange(a.row, 2).setValue(a.folderId);
  }
  sh.getRange(a.row, 4).setValue(folder.getUrl());
  return folder;
}

/** 投稿者名 → フォルダ。accounts にないアカウントは行を追加してフォルダも作る */
function makeFolderResolver_() {
  const acc = loadAccounts_();
  const cache = {};
  return name => {
    name = normName_(name);
    const k = name.toLowerCase();
    if (cache[k]) return cache[k];
    let a = acc.list.find(x => x.name.toLowerCase() === k);
    if (!a) {
      acc.sh.appendRow([name, '', false]);
      a = { row: acc.sh.getLastRow(), name, folderId: '', api: false, lastRun: 0 };
      acc.sh.getRange(a.row, 3).insertCheckboxes();
      acc.list.push(a);
    }
    cache[k] = ensureFolder_(acc.sh, a);
    return cache[k];
  };
}

function getParentFolder_() {
  return CONFIG.PARENT_FOLDER_ID ? DriveApp.getFolderById(CONFIG.PARENT_FOLDER_ID) : DriveApp.getRootFolder();
}

/* ===================== URLリスト ===================== */

function processUrlList_(deadline) {
  const sh = getSheet_(SHEET_URLS, URLS_HEADER);
  const last = sh.getLastRow();
  if (last < 2) return;

  const idx = loadIndex_();
  const folderFor = makeFolderResolver_();
  const rows = sh.getRange(2, 1, last - 1, 2).getValues();

  for (let i = 0; i < rows.length; i++) {
    if (Date.now() > deadline) break;
    const url = String(rows[i][0] || '').trim();
    const status = String(rows[i][1] || '');
    if (!url || status.startsWith('完了')) continue;

    let msg;
    try {
      const id = extractPostId_(url);
      if (!id) throw new Error('URLからポストIDを読み取れません');
      const post = fetchPostViaFx_(id);
      const folder = folderFor(post.author);
      const r = savePost_(idx, folder, post, deadline);
      if (!r.finished) msg = `途中（時間切れ）@${post.author} 保存${r.saved} / 重複${r.skipped}`;
      else if (post.media.length === 0) msg = `完了 @${post.author}（画像・動画なし）`;
      else msg = `完了 @${post.author} 保存${r.saved} / 重複スキップ${r.skipped}` + (r.failed ? ` / 失敗${r.failed}` : '');
    } catch (e) {
      msg = 'エラー: ' + e.message;
    }
    sh.getRange(i + 2, 2, 1, 2).setValues([[msg, new Date()]]);
    Utilities.sleep(500);
  }
}

function extractPostId_(url) {
  const m = url.match(/status(?:es)?\/(\d+)/);
  return m ? m[1] : null;
}

function fetchPostViaFx_(postId) {
  const res = UrlFetchApp.fetch('https://api.fxtwitter.com/status/' + postId, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (x-to-drive script)' },
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`ポスト取得失敗（${res.getResponseCode()}）削除・非公開・鍵垢の可能性`);
  }
  const t = JSON.parse(res.getContentText()).tweet;
  if (!t) throw new Error('ポストが見つかりません');
  const all = (t.media && t.media.all) || [];
  return {
    id: String(t.id),
    url: t.url,
    author: (t.author && t.author.screen_name) || 'unknown',
    media: all.map((m, i) => normalizeMedia_(m.url, m.type, i)).filter(Boolean),
  };
}

/* ===================== 全投稿取得（公式API） ===================== */

function syncAllAccounts_(deadline) {
  const token = getBearerToken_();
  if (!token) throw new Error('スクリプトプロパティ X_BEARER_TOKEN を設定してください');

  const acc = loadAccounts_();
  // 前回処理が古いアカウントから順に（どのアカウントも順番に進むように）
  const targets = acc.list.filter(a => a.api).sort((a, b) => a.lastRun - b.lastRun);
  if (!targets.length) return;
  const idx = loadIndex_();

  for (const a of targets) {
    if (Date.now() > deadline) break;
    let msg;
    try {
      const folder = ensureFolder_(acc.sh, a);
      msg = syncAccount_(token, a.name, folder, idx, deadline);
    } catch (e) {
      msg = 'エラー: ' + e.message;
    }
    acc.sh.getRange(a.row, 5, 1, 2).setValues([[msg, new Date()]]);
  }
}

/** 1アカウント分。取得状況はアカウントごとに別々に記録する */
function syncAccount_(token, name, folder, idx, deadline) {
  const props = PropertiesService.getScriptProperties();
  // 取得状況はモードごとに別に記録（切り替えると新しいモードで過去分を取り直す。保存済みのものは重複チェックで飛ばす）
  const mode = CONFIG.MEDIA_ONLY ? 'MEDIA' : 'ALL';
  const k = s => s + '_' + mode + '_' + name.toLowerCase();
  const userId = CONFIG.MEDIA_ONLY ? null : getUserId_(token, name);
  const cnt = { saved: 0, skipped: 0 };

  // 設定シートで遡る件数が増やされていたら、過去分を取り直す（保存済みのものは重複チェックで飛ばす）
  if (props.getProperty(k('BACKFILL_DONE')) === '1') {
    const stored = props.getProperty(k('BACKFILL_LIMIT'));
    const prev = stored === null ? 100 : Number(stored); // 記録がない＝前のバージョン（100件）で取得済み
    const now = CONFIG.MAX_PAST_POSTS;
    if (prev !== 0 && (now === 0 || now > prev)) {
      props.deleteProperty(k('BACKFILL_DONE'));
      props.deleteProperty(k('BACKFILL_TOKEN'));
      props.deleteProperty(k('BACKFILL_COUNT'));
    }
  }

  // 1) 過去分を遡る（終わるまで毎回続きから）
  if (props.getProperty(k('BACKFILL_DONE')) !== '1') {
    props.setProperty(k('BACKFILL_LIMIT'), String(CONFIG.MAX_PAST_POSTS));
    const limit = CONFIG.MAX_PAST_POSTS;
    let doneCount = Number(props.getProperty(k('BACKFILL_COUNT')) || 0);
    while (true) {
      if (Date.now() > deadline) return `過去分を取得中（今回 保存${cnt.saved}）次回続き`;
      const pt = props.getProperty(k('BACKFILL_TOKEN')) || '';
      const remaining = limit ? limit - doneCount : 100;
      const json = fetchPage_(token, name, userId, {
        paginationToken: pt,
        maxResults: Math.min(100, remaining),
      });
      if (!pt && json.meta && json.meta.newest_id && !props.getProperty(k('SINCE_ID'))) {
        props.setProperty(k('SINCE_ID'), json.meta.newest_id);
      }
      let posts = apiResponseToPosts_(json, name);
      if (limit) posts = posts.slice(0, Math.max(0, limit - doneCount));
      // ページの途中で時間切れなら次回同じページからやり直す（重複チェックで二重保存はされない）
      if (!savePosts_(idx, folder, posts, deadline, cnt)) {
        return `過去分を取得中（今回 保存${cnt.saved}）次回続き`;
      }
      doneCount += posts.length;
      props.setProperty(k('BACKFILL_COUNT'), String(doneCount));
      const next = json.meta && json.meta.next_token;
      if (next && (!limit || doneCount < limit)) {
        props.setProperty(k('BACKFILL_TOKEN'), next);
      } else {
        props.setProperty(k('BACKFILL_DONE'), '1');
        props.deleteProperty(k('BACKFILL_TOKEN'));
        break;
      }
    }
  }

  // 2) 前回以降の新しい投稿だけ取得
  const sinceId = props.getProperty(k('SINCE_ID')) || '';
  let pt = '';
  let newest = sinceId;
  do {
    if (Date.now() > deadline) return `新着を取得中（今回 保存${cnt.saved}）次回続き`;
    const json = fetchPage_(token, name, userId, { sinceId, paginationToken: pt });
    if (!json.meta || json.meta.result_count === 0) break;
    if (!pt && json.meta.newest_id) newest = json.meta.newest_id;
    if (!savePosts_(idx, folder, apiResponseToPosts_(json, name), deadline, cnt)) {
      return `新着を取得中（今回 保存${cnt.saved}）次回続き`;
    }
    pt = json.meta.next_token || '';
  } while (pt);
  if (newest) props.setProperty(k('SINCE_ID'), newest);

  return `最新まで取得済み（今回 保存${cnt.saved} / 重複${cnt.skipped}` +
    (cnt.failed ? ` / 失敗${cnt.failed}（logシート参照）` : '') +
    (bigQueued_ ? ` / 大きい動画${bigQueued_}件はGitHubで保存` : '') + '）';
}

function getBearerToken_() {
  return PropertiesService.getScriptProperties().getProperty('X_BEARER_TOKEN');
}

function getUserId_(token, name) {
  const props = PropertiesService.getScriptProperties();
  const cacheKey = 'USER_ID_' + name.toLowerCase();
  const cached = props.getProperty(cacheKey);
  if (cached) return cached;
  const json = xApiGet_(token, 'https://api.x.com/2/users/by/username/' + encodeURIComponent(name));
  if (!json.data) throw new Error('アカウントが見つかりません: ' + name);
  props.setProperty(cacheKey, json.data.id);
  return json.data.id;
}

/** MEDIA_ONLY の設定に合わせて、検索（画像・動画付きのみ）かタイムライン（全投稿）を使い分ける */
function fetchPage_(token, name, userId, opts) {
  return CONFIG.MEDIA_ONLY
    ? fetchMediaSearchPage_(token, name, opts)
    : fetchTimelinePage_(token, userId, opts);
}

/** 全期間検索で「from:アカウント has:media」の投稿だけを取得 */
function fetchMediaSearchPage_(token, name, opts) {
  let query = `from:${name} has:media`;
  if (!CONFIG.INCLUDE_RETWEETS) query += ' -is:retweet';
  if (!CONFIG.INCLUDE_REPLIES) query += ' -is:reply';

  const q = {
    query,
    max_results: Math.max(10, Math.min(100, opts.maxResults || 100)), // 検索APIの指定範囲は10〜
    sort_order: 'recency',
    expansions: 'attachments.media_keys',
    'media.fields': 'media_key,type,url,variants',
  };
  if (opts.paginationToken) q.next_token = opts.paginationToken;
  if (opts.sinceId) q.since_id = opts.sinceId;
  else q.start_time = '2006-03-21T00:00:00Z'; // 指定しないと直近30日分しか返らないため

  Utilities.sleep(1100); // 全期間検索は1秒に1回までの制限があるため
  const qs = Object.keys(q).map(k => k + '=' + encodeURIComponent(q[k])).join('&');
  return xApiGet_(token, 'https://api.x.com/2/tweets/search/all?' + qs);
}

function fetchTimelinePage_(token, userId, opts) {
  const q = {
    max_results: Math.max(5, Math.min(100, opts.maxResults || 100)), // APIの指定範囲は5〜100
    expansions: 'attachments.media_keys',
    'media.fields': 'media_key,type,url,variants',
  };
  const exclude = [];
  if (!CONFIG.INCLUDE_RETWEETS) exclude.push('retweets');
  if (!CONFIG.INCLUDE_REPLIES) exclude.push('replies');
  if (exclude.length) q.exclude = exclude.join(',');
  if (opts.paginationToken) q.pagination_token = opts.paginationToken;
  if (opts.sinceId) q.since_id = opts.sinceId;

  const qs = Object.keys(q).map(k => k + '=' + encodeURIComponent(q[k])).join('&');
  return xApiGet_(token, `https://api.x.com/2/users/${userId}/tweets?${qs}`);
}

function xApiGet_(token, url) {
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 429) throw new Error('X APIのレート制限中です。時間をおいて再実行してください');
  if (code !== 200) throw new Error(`X APIエラー（${code}）: ${res.getContentText().slice(0, 300)}`);
  return JSON.parse(res.getContentText());
}

function apiResponseToPosts_(json, name) {
  const mediaMap = {};
  ((json.includes && json.includes.media) || []).forEach(m => { mediaMap[m.media_key] = m; });

  return (json.data || []).map(t => {
    const keys = (t.attachments && t.attachments.media_keys) || [];
    const media = keys.map((k, i) => {
      const m = mediaMap[k];
      if (!m) return null;
      if (m.type === 'photo') return normalizeMedia_(m.url, 'photo', i);
      // 動画・GIF は一番高画質の mp4 を選ぶ
      const best = (m.variants || [])
        .filter(v => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
      return best ? normalizeMedia_(best.url, m.type, i) : null;
    }).filter(Boolean);

    return { id: String(t.id), url: `https://x.com/${name}/status/${t.id}`, author: name, media };
  });
}

/* ===================== 保存・重複チェック ===================== */

/**
 * メディアURLを、ダウンロード用URL・拡張子・重複判定キーに整える
 * 画像は ?name=orig で原寸を取得。キーはURLリスト／公式APIのどちらでも同じになるようにしている
 */
function normalizeMedia_(url, type, index) {
  if (!url) return null;
  const clean = url.split('?')[0];
  if (type === 'photo') {
    const ext = (clean.match(/\.(\w+)$/) || [, 'jpg'])[1];
    return { key: 'photo:' + clean.split('/').pop(), url: clean + '?name=orig', type, ext, index };
  }
  // 動画: ext_tw_video/<id>/... または amplify_video/<id>/...（解像度違いでも同じキー）
  const vid = clean.match(/(?:ext_tw_video|amplify_video)\/(\d+)/);
  const key = vid ? 'video:' + vid[1] : 'video:' + clean.split('/').pop();
  return { key, url, type, ext: 'mp4', index };
}

function savePosts_(idx, folder, posts, deadline, cnt) {
  for (const post of posts) {
    const r = savePost_(idx, folder, post, deadline);
    cnt.saved += r.saved;
    cnt.skipped += r.skipped;
    cnt.failed = (cnt.failed || 0) + r.failed;
    if (!r.finished) return false;
  }
  return true;
}

/** 1ポスト分を folder（アカウントのフォルダ）に保存。戻り値 { saved, skipped, finished } */
function savePost_(idx, folder, post, deadline) {
  const fid = folder.getId();
  let saved = 0, skipped = 0, failed = 0;

  for (const m of post.media) {
    if (Date.now() > deadline) return { saved, skipped, failed, finished: false };
    if (idx.keys.has(fid + '|' + m.key)) { skipped++; continue; }

    // 1つ失敗しても止めずに次へ進む（以前は1つの失敗でそのアカウント全体が止まっていた）
    let res;
    try {
      res = UrlFetchApp.fetch(m.url, { muteHttpExceptions: true, followRedirects: true });
    } catch (e) {
      const fileName0 = `${post.author}_${post.id}_${m.index + 1}.${m.ext}`;
      if (m.type !== 'photo') {
        // 50MB超の動画 →「大きい動画」シートに入れて、GitHub（Python）に保存を頼む
        const target0 = CONFIG.SUBFOLDER_PER_POST ? getOrCreateSubfolder_(folder, `${post.author}_${post.id}`) : folder;
        bigEnqueue_({ key: m.key, postId: post.id, postUrl: post.url, type: m.type, name: fileName0,
          folderId: target0.getId(), indexFolderId: fid, url: m.url, account: post.author });
        idx.sh.appendRow([m.key, post.id, post.url, m.type, fileName0, '', 'big-queued', new Date(), post.author, fid]);
        idx.keys.add(fid + '|' + m.key);
        bigQueued_++;
        continue;
      }
      // 画像で取れないもの → log に記録して次回からは飛ばす
      idx.sh.appendRow([m.key, post.id, post.url, m.type, '', '', 'failed: ' + String(e.message).slice(0, 200), new Date(), post.author, fid]);
      idx.keys.add(fid + '|' + m.key);
      failed++;
      continue;
    }
    if (res.getResponseCode() !== 200) {
      failed++; // 一時的なエラーの可能性があるので記録せず、次回もう一度試す
      continue;
    }
    const blob = res.getBlob();
    const hash = md5_(blob.getBytes());
    const fileName = `${post.author}_${post.id}_${m.index + 1}.${m.ext}`;
    const now = new Date();

    if (idx.md5s.has(fid + '|' + hash)) {
      // 同じフォルダに中身が同じファイルがある → 保存せず、キーだけ記録して次回はダウンロードもしない
      idx.sh.appendRow([m.key, post.id, post.url, m.type, fileName, hash, 'duplicate', now, post.author, fid]);
      idx.keys.add(fid + '|' + m.key);
      skipped++;
      continue;
    }

    const target = CONFIG.SUBFOLDER_PER_POST ? getOrCreateSubfolder_(folder, `${post.author}_${post.id}`) : folder;
    const file = target.createFile(blob.setName(fileName));

    idx.sh.appendRow([m.key, post.id, post.url, m.type, fileName, hash, file.getId(), now, post.author, fid]);
    idx.keys.add(fid + '|' + m.key);
    idx.md5s.add(fid + '|' + hash);
    saved++;
  }
  return { saved, skipped, failed, finished: true };
}

/** 各アカウントのフォルダ（サブフォルダ含む）に元からあるファイルを重複チェック対象に登録 */
function indexExistingFiles() {
  loadSettings_();
  const deadline = Date.now() + CONFIG.MAX_RUNTIME_MS;
  const idx = loadIndex_();
  const acc = loadAccounts_();
  let added = 0;
  let timedOut = false;

  for (const a of acc.list) {
    if (timedOut) break;
    const top = ensureFolder_(acc.sh, a);
    const fid = top.getId();
    const walk = folder => {
      const files = folder.getFiles();
      while (files.hasNext()) {
        if (Date.now() > deadline) { timedOut = true; return; }
        const f = files.next();
        if (idx.fileIds.has(f.getId())) continue;
        const hash = md5_(f.getBlob().getBytes());
        idx.sh.appendRow(['existing:' + f.getId(), '', '', f.getMimeType(), f.getName(), hash, f.getId(), new Date(), a.name, fid]);
        idx.fileIds.add(f.getId());
        idx.md5s.add(fid + '|' + hash);
        added++;
      }
      const subs = folder.getFolders();
      while (subs.hasNext() && !timedOut) walk(subs.next());
    };
    walk(top);
  }

  SpreadsheetApp.getActive().toast(
    timedOut ? `${added}件登録（時間切れ。もう一度実行すると続きから）` : `${added}件登録しました`
  );
}

function loadIndex_() {
  const sh = getSheet_(SHEET_LOG, LOG_HEADER);
  const keys = new Set(), md5s = new Set(), fileIds = new Set();
  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, LOG_HEADER.length).getValues().forEach(r => {
      const fid = String(r[9] || '');
      if (r[0]) keys.add(fid + '|' + r[0]);
      if (r[5]) md5s.add(fid + '|' + r[5]);
      if (r[6]) fileIds.add(String(r[6]));
    });
  }
  return { sh, keys, md5s, fileIds };
}

/* ===================== ユーティリティ ===================== */

function md5_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('');
}

function getSheet_(name, header) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(header);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ===================== 大きい動画（50MB超）を GitHub（Python）で保存 ===================== */
/*
 * Apps Script は 50MB を超えるファイルを受け取れないため、そういう動画は「大きい動画」シートに入れて、
 * GitHub Actions の Python（x-uploader リポジトリの x2drive.py）に保存を頼む。
 *   1. 保存の実行が終わると、待ちの動画があれば GitHub に合図を送る
 *   2. Python が doGet(?x2d=jobs) で動画の一覧と、ドライブに書き込むための一時的な鍵を受け取る
 *   3. Python が X から動画をダウンロード → ドライブのアカウントのフォルダにアップロード
 *   4. Python が doGet(?x2d=done / fail) で結果を返す（中身が同じ動画が既にあれば、アップロードした方を削除）
 * 状態: 待ち → 作業中 → 完了 / 失敗（「失敗した動画をやり直す」で 待ち に戻せる）
 */

let bigQueued_ = 0;
const BIG = {
  SHEET: '大きい動画',
  HEADER: ['id', '状態', 'account', 'post_url', 'file_name', 'folder_id', 'media_key', 'type', 'post_id', 'index_folder_id', 'video_url', 'メモ', 'updated'],
  WORKFLOW: 'x2drive.yml',
  STALE_MS: 45 * 60 * 1000, // 作業中のまま45分たったものは、もう一度渡す
  BATCH: 5,
};

function bigSheet_() { return getSheet_(BIG.SHEET, BIG.HEADER); }

function bigEnqueue_(j) {
  bigSheet_().appendRow([Utilities.getUuid(), '待ち', j.account, j.postUrl, j.name, j.folderId, j.key, j.type,
    j.postId, j.indexFolderId, j.url, '', new Date()]);
}

function bigRows_() {
  const sh = bigSheet_();
  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, BIG.HEADER.length).getValues() : [];
  return { sh, rows };
}

function bigSetState_(sh, rowIndex, state, memo) {
  sh.getRange(rowIndex + 2, 2).setValue(state);
  if (memo !== undefined) sh.getRange(rowIndex + 2, 12).setValue(memo);
  sh.getRange(rowIndex + 2, 13).setValue(new Date());
}

function bigHasWaiting_() {
  const now = Date.now();
  return bigRows_().rows.some(r => r[1] === '待ち' ||
    (r[1] === '作業中' && r[12] instanceof Date && now - r[12].getTime() > BIG.STALE_MS));
}

/** 待ちの動画があれば GitHub を起動（GitHub連携が未登録なら何もしない） */
function bigDispatchIfNeeded_() {
  try {
    const p = PropertiesService.getScriptProperties();
    if (!p.getProperty('X2D_GH_REPO') || !p.getProperty('X2D_GH_TOKEN')) return;
    if (bigHasWaiting_()) bigDispatch_();
  } catch (e) { /* 起動に失敗しても、ほかの保存は止めない */ }
}

function bigDispatch_() {
  const p = PropertiesService.getScriptProperties();
  const repo = p.getProperty('X2D_GH_REPO'), tok = p.getProperty('X2D_GH_TOKEN');
  if (!repo || !tok) return { ok: false, msg: 'GitHub連携が未登録です（メニュー「大きい動画」①）' };
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/actions/workflows/' + BIG.WORKFLOW + '/dispatches', {
    method: 'post', muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ ref: p.getProperty('X2D_GH_REF') || 'main' }),
  });
  const code = res.getResponseCode();
  if (code === 204) return { ok: true, msg: 'OK' };
  return { ok: false, msg: 'GitHubの起動に失敗（' + code + '）: ' + res.getContentText().slice(0, 200) };
}

/* ---- メニュー ---- */

function bigSaveGithub() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('GitHubのリポジトリ名を「ユーザー名/リポジトリ名」の形で入力してください（例: yourname/x-uploader）');
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const repo = r1.getResponseText().trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { ui.alert('形が違います。「ユーザー名/リポジトリ名」で入力してください。'); return; }
  const r2 = ui.prompt('GitHubのトークン（Fine-grained token）を貼り付けてください。\n（自動ローテで使っているものと同じでOK。このスクリプトの中だけに保存されます）');
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const tok = r2.getResponseText().trim();
  if (!tok) { ui.alert('トークンが空です。'); return; }
  const p = PropertiesService.getScriptProperties();
  p.setProperty('X2D_GH_REPO', repo);
  p.setProperty('X2D_GH_TOKEN', tok);
  ui.alert('登録しました。「【テスト】GitHubを起動できるか確認」で確かめられます。');
}

function bigKey_() {
  const p = PropertiesService.getScriptProperties();
  let key = p.getProperty('X2D_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    p.setProperty('X2D_KEY', key);
  }
  return key;
}

function bigShowKey() {
  const key = bigKey_();
  const url = ScriptApp.getService().getUrl() || '（ウェブアプリが未公開です。「デプロイ」→「新しいデプロイ」→ ウェブアプリ で公開してください）';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.6">' +
    '<p>GitHub の x-uploader →「Settings」→「Secrets and variables」→「Actions」に、次の2つを登録してください。</p>' +
    '<p><b>X2D_GAS_URL</b><br><input style="width:100%" readonly value="' + esc(url) + '" onclick="this.select()"></p>' +
    '<p><b>X2D_KEY</b><br><input style="width:100%" readonly value="' + esc(key) + '" onclick="this.select()"></p>' +
    '<p style="color:#666">URLが …/dev で終わる場合は、「デプロイを管理」に出ている …/exec のURLを使ってください。</p></div>'
  ).setWidth(560).setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, 'Python用の合言葉とURL');
}

function bigTestDispatch() {
  const r = bigDispatch_();
  SpreadsheetApp.getUi().alert(r.ok
    ? 'GitHubを起動できました。GitHubの「Actions」タブに「x2drive」が出ていればOKです。'
    : r.msg);
}

function bigDispatchNow() {
  if (!bigHasWaiting_()) { SpreadsheetApp.getUi().alert('待ちの動画はありません。'); return; }
  const r = bigDispatch_();
  SpreadsheetApp.getUi().alert(r.ok ? 'GitHubに保存を頼みました。数分後に「大きい動画」シートの状態を見てください。' : r.msg);
}

function bigRetryFailed() {
  const { sh, rows } = bigRows_();
  let n = 0;
  rows.forEach((r, i) => { if (r[1] === '失敗') { bigSetState_(sh, i, '待ち', ''); n++; } });
  if (n) bigDispatchIfNeeded_();
  SpreadsheetApp.getUi().alert(n ? `${n}件を「待ち」に戻しました。` : '失敗した動画はありません。');
}

/* ---- Python とのやりとり（ウェブアプリ） ---- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.x2d) return bigWeb_(p);
  return ContentService.createTextOutput('ok');
}

function bigJson_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function bigWeb_(p) {
  const key = PropertiesService.getScriptProperties().getProperty('X2D_KEY');
  if (!key || p.key !== key) return bigJson_({ ok: false, error: 'bad key' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const { sh, rows } = bigRows_();
    const now = Date.now();

    if (p.x2d === 'jobs') {
      // 待ちの動画を渡す（渡したものは「作業中」にして、二重に渡さない）
      const jobs = [];
      rows.forEach((r, i) => {
        if (jobs.length >= BIG.BATCH) return;
        const stale = r[1] === '作業中' && r[12] instanceof Date && now - r[12].getTime() > BIG.STALE_MS;
        if (r[1] !== '待ち' && !stale) return;
        bigSetState_(sh, i, '作業中');
        jobs.push({ id: String(r[0]), url: String(r[10]), name: String(r[4]), folderId: String(r[5]) });
      });
      // ドライブに書き込むための一時的な鍵（約1時間で切れる）
      return bigJson_({ ok: true, jobs, driveToken: jobs.length ? ScriptApp.getOAuthToken() : '' });
    }

    const i = rows.findIndex(r => String(r[0]) === String(p.job || ''));
    if (i < 0) return bigJson_({ ok: false, error: 'no job' });
    const r = rows[i];

    if (p.x2d === 'done') {
      const fileId = String(p.file || ''), md5 = String(p.md5 || '');
      const idx = loadIndex_();
      const fid = String(r[9]);
      if (md5 && idx.md5s.has(fid + '|' + md5)) {
        // 同じフォルダに中身が同じ動画がある → アップロードした方を削除
        try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e2) { /* 消せなくても続行 */ }
        idx.sh.appendRow([r[6], r[8], r[3], r[7], r[4], md5, 'duplicate', new Date(), r[2], fid]);
        bigSetState_(sh, i, '完了', '同じ動画があったので削除');
      } else {
        idx.sh.appendRow([r[6], r[8], r[3], r[7], r[4], md5, fileId, new Date(), r[2], fid]);
        const mb = p.size ? Math.round(Number(p.size) / 1024 / 1024) + 'MB' : '';
        bigSetState_(sh, i, '完了', mb);
      }
      return bigJson_({ ok: true });
    }

    if (p.x2d === 'fail') {
      bigSetState_(sh, i, '失敗', String(p.err || '不明なエラー').slice(0, 300));
      return bigJson_({ ok: true });
    }
    return bigJson_({ ok: false, error: 'bad request' });
  } finally {
    lock.releaseLock();
  }
}
