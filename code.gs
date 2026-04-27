/**
 * 居酒屋オーダー・売上管理システム  -  Backend (Google Apps Script)
 *
 * シート:
 *   ActiveOrders: 席番号 | 商品名 | 単価 | 数量 | 小計 | タイムスタンプ
 *   SalesHistory: 日時   | 席番号 | 商品名 | 単価 | 数量 | 税込合計
 *   Menu        : 商品名 | 単価   | カテゴリ
 *   SeatState   : 席番号 | グループリーダー | 人数 | 開店時刻
 *
 * 席ID 内部表現:
 *   カウンター = "C1" .. "C8"   (表示は「カウンター1」)
 *   テーブル   = "TA", "TB"     (表示は「A卓」「B卓」)
 *
 * 税率: 10% 固定
 */

// ============================================================
// 定数
// ============================================================
const SHEET_ACTIVE  = 'ActiveOrders';
const SHEET_HISTORY = 'SalesHistory';
const SHEET_MENU    = 'Menu';
const SHEET_SEATS   = 'SeatState';

const HEADERS_ACTIVE  = ['席番号', '商品名', '単価', '数量', '小計', 'タイムスタンプ'];
const HEADERS_HISTORY = ['日時', '席番号', '商品名', '単価', '数量', '税込合計'];
const HEADERS_MENU    = ['商品名', '単価', 'カテゴリ'];
const HEADERS_SEATS   = ['席番号', 'グループリーダー', '人数', '開店時刻'];

const TAX_RATE = 0.10;

const OTOSHI_NAME = 'お通し';
const OTOSHI_DEFAULT_PRICE = 500;

const COUNTER_SEATS = ['C1','C2','C3','C4','C5','C6','C7','C8'];
const TABLE_SEATS   = ['T'];
const ALL_SEATS     = COUNTER_SEATS.concat(TABLE_SEATS);

// ============================================================
// HTTP エントリーポイント (JSON API)
//   GET  ?action=<fn>&payload=<JSON配列>
//   POST  body: { action, args }
// ============================================================
function doGet(e) {
  return apiHandle_(e && e.parameter ? e.parameter.action : null,
                    e && e.parameter ? e.parameter.payload : null);
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (_) {}
  return apiHandle_(body.action, JSON.stringify(body.args || []));
}

function apiHandle_(action, payload) {
  try {
    if (!action) throw new Error('action パラメータが必要です');
    const fn = API_ACTIONS_[action];
    if (!fn) throw new Error('未定義のaction: ' + action);
    const args = payload ? JSON.parse(payload) : [];
    const data = fn.apply(null, Array.isArray(args) ? args : [args]);
    return jsonResponse_({ ok: true, data: data });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String((err && err.message) || err) });
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// クライアントから呼べるAPI一覧（関数定義は下方）
const API_ACTIONS_ = {
  getDashboard:    function () { return getDashboard(); },
  getSeatBill:     function (seatId) { return getSeatBill(seatId); },
  openSeat:        function (seatId, guests) { return openSeat(seatId, guests); },
  addOrder:        function (seatId, p, price, qty) { return addOrder(seatId, p, price, qty); },
  removeOrderItem: function (row) { return removeOrderItem(row); },
  updateOrderQty:  function (row, qty) { return updateOrderQty(row, qty); },
  updateGuests:    function (seatId, n) { return updateGuests(seatId, n); },
  groupSeats:      function (ids) { return groupSeats(ids); },
  ungroupSeat:     function (seatId) { return ungroupSeat(seatId); },
  checkout:        function (seatId) { return checkout(seatId); }
};

// ============================================================
// シート初期化
// ============================================================
function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight('bold')
      .setBackground('#f1f3f5');
    sh.setFrozenRows(1);

    if (name === SHEET_MENU) {
      sh.getRange(2, 1, 10, 3).setValues([
        ['お通し',     500, 'お通し'],
        ['生ビール',    600, 'ドリンク'],
        ['ハイボール',  500, 'ドリンク'],
        ['レモンサワー', 500, 'ドリンク'],
        ['ウーロン茶',  300, 'ソフト'],
        ['枝豆',       400, 'フード'],
        ['唐揚げ',     600, 'フード'],
        ['刺身盛り合せ',1200,'フード'],
        ['焼き鳥盛り',  900, 'フード'],
        ['シメパフェ', 700, 'デザート']
      ]);
    }
  }
  return sh;
}

function ensureAllSheets_() {
  getSheet_(SHEET_ACTIVE,  HEADERS_ACTIVE);
  getSheet_(SHEET_HISTORY, HEADERS_HISTORY);
  getSheet_(SHEET_MENU,    HEADERS_MENU);
  getSheet_(SHEET_SEATS,   HEADERS_SEATS);
}

// ============================================================
// データ取得（内部用）
// ============================================================
function getMenu() {
  const sh = getSheet_(SHEET_MENU, HEADERS_MENU);
  const last = sh.getLastRow();
  if (last <= 1) return [];
  return sh.getRange(2, 1, last - 1, 3).getValues()
    .filter(r => r[0] && r[1])
    .map(r => ({
      name: String(r[0]).trim(),
      price: Number(r[1]) || 0,
      category: String(r[2] || 'その他').trim()
    }));
}

function getOtoshiPrice_() {
  const m = getMenu().find(x => x.name === OTOSHI_NAME);
  return m ? m.price : OTOSHI_DEFAULT_PRICE;
}

function getSeatStates_() {
  const sh = getSheet_(SHEET_SEATS, HEADERS_SEATS);
  const last = sh.getLastRow();
  if (last <= 1) return [];
  return sh.getRange(2, 1, last - 1, HEADERS_SEATS.length).getValues()
    .map((r, i) => ({
      row: i + 2,
      seatId: String(r[0] || '').trim(),
      groupLeader: String(r[1] || '').trim(),
      guests: Number(r[2]) || 0,
      openedAt: r[3]
    }))
    .filter(s => s.seatId);
}

function findSeatStateRow_(seatId) {
  const states = getSeatStates_();
  const s = states.find(x => x.seatId === seatId);
  return s ? s.row : -1;
}

function getActiveOrders_() {
  const sh = getSheet_(SHEET_ACTIVE, HEADERS_ACTIVE);
  const last = sh.getLastRow();
  if (last <= 1) return [];
  return sh.getRange(2, 1, last - 1, HEADERS_ACTIVE.length).getValues()
    .map((r, i) => ({
      row: i + 2,
      seatId: String(r[0] || '').trim(),
      product: String(r[1] || ''),
      price: Number(r[2]) || 0,
      qty: Number(r[3]) || 0,
      subtotal: Number(r[4]) || 0,
      timestamp: r[5]
    }))
    .filter(o => o.seatId);
}

function getLeaderOf_(seatId, statesCache) {
  const states = statesCache || getSeatStates_();
  const s = states.find(x => x.seatId === seatId);
  if (!s) return seatId;
  return s.groupLeader || seatId;
}

// ============================================================
// 公開API
// ============================================================

/** 画面表示用ダッシュボード一括取得 */
function getDashboard() {
  ensureAllSheets_();

  const states = getSeatStates_();
  const orders = getActiveOrders_();
  const menu   = getMenu();

  // 各席の初期情報
  const seatInfo = {};
  ALL_SEATS.forEach(id => {
    seatInfo[id] = {
      seatId: id,
      label: seatLabel_(id),
      isCounter: id.charAt(0) === 'C',
      isOpen: false,
      isLeader: false,
      isMember: false,
      groupLeader: '',
      groupMembers: [],
      guests: 0,
      openedAt: null,
      subtotal: 0,
      taxIncluded: 0,
      itemCount: 0
    };
  });

  // 状態反映
  states.forEach(s => {
    if (!seatInfo[s.seatId]) return;
    seatInfo[s.seatId].isOpen = true;
    seatInfo[s.seatId].guests = s.guests;
    seatInfo[s.seatId].openedAt = s.openedAt;
    seatInfo[s.seatId].groupLeader = s.groupLeader;
  });

  // グループ関係
  states.forEach(s => {
    if (s.groupLeader && s.groupLeader !== s.seatId && seatInfo[s.groupLeader]) {
      if (seatInfo[s.seatId]) seatInfo[s.seatId].isMember = true;
      seatInfo[s.groupLeader].isLeader = true;
      seatInfo[s.groupLeader].groupMembers.push(s.seatId);
    }
  });
  ALL_SEATS.forEach(id => {
    if (seatInfo[id].isLeader) {
      seatInfo[id].groupMembers.unshift(id);
      seatInfo[id].groupMembers.sort();
      // グループ全体の人数を集計
      let total = seatInfo[id].guests;
      seatInfo[id].groupMembers.forEach(mid => {
        if (mid !== id) {
          const ms = states.find(x => x.seatId === mid);
          if (ms) total += ms.guests;
        }
      });
      seatInfo[id].guests = total;
    }
  });

  // 注文集計（リーダー席に集約済み）
  orders.forEach(o => {
    if (seatInfo[o.seatId]) {
      seatInfo[o.seatId].subtotal += o.subtotal;
      seatInfo[o.seatId].itemCount += o.qty;
    }
  });
  ALL_SEATS.forEach(id => {
    seatInfo[id].taxIncluded = Math.round(seatInfo[id].subtotal * (1 + TAX_RATE));
  });

  return {
    seats: ALL_SEATS.map(id => seatInfo[id]),
    menu,
    summary: getSalesSummary_(),
    taxRate: TAX_RATE,
    otoshiPrice: getOtoshiPrice_()
  };
}

/** 席を開く（人数入力 → お通し自動加算） */
function openSeat(seatId, guests) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    seatId = String(seatId).trim();
    guests = Number(guests) || 0;
    if (ALL_SEATS.indexOf(seatId) < 0) throw new Error('無効な席ID: ' + seatId);
    if (guests < 1) throw new Error('人数は1名以上を指定してください');
    if (findSeatStateRow_(seatId) > 0) throw new Error('この席はすでに開いています');

    const sh = getSheet_(SHEET_SEATS, HEADERS_SEATS);
    sh.appendRow([seatId, '', guests, new Date()]);

    const otoshiPrice = getOtoshiPrice_();
    if (otoshiPrice > 0) {
      _addOrderInternal(seatId, OTOSHI_NAME, otoshiPrice, guests);
    }
    return getDashboard();
  } finally {
    lock.releaseLock();
  }
}

function _addOrderInternal(seatId, product, price, qty) {
  const leader = getLeaderOf_(seatId);
  if (findSeatStateRow_(leader) < 0) throw new Error('席が開いていません');
  const sh = getSheet_(SHEET_ACTIVE, HEADERS_ACTIVE);

  // 同一席・同一商品・同一単価の既存行があれば数量をマージ
  const existing = getActiveOrders_().find(o =>
    o.seatId === leader &&
    o.product === product &&
    Number(o.price) === Number(price)
  );
  if (existing) {
    const newQty = existing.qty + qty;
    const newSubtotal = price * newQty;
    sh.getRange(existing.row, 4).setValue(newQty);     // 数量列
    sh.getRange(existing.row, 5).setValue(newSubtotal); // 小計列
    return;
  }
  const subtotal = price * qty;
  sh.appendRow([leader, product, price, qty, subtotal, new Date()]);
}

/** 客の人数を変更（リーダー席に対して反映） */
function updateGuests(seatId, newGuests) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    seatId = String(seatId);
    newGuests = Number(newGuests) || 0;
    if (newGuests < 1) throw new Error('人数は1名以上');
    if (newGuests > 30) throw new Error('人数は30名以下');

    const sh = getSheet_(SHEET_SEATS, HEADERS_SEATS);
    const states = getSeatStates_();
    const leader = getLeaderOf_(seatId, states);
    const leaderState = states.find(s => s.seatId === leader);
    if (!leaderState) throw new Error('席が開いていません');

    // グループ席の場合、メンバー側の人数を 0 にしてリーダーに集約
    states
      .filter(s => s.groupLeader === leader && s.seatId !== leader)
      .forEach(s => sh.getRange(s.row, 3).setValue(0));

    sh.getRange(leaderState.row, 3).setValue(newGuests);
    return getDashboard();
  } finally {
    lock.releaseLock();
  }
}

/** 明細の数量を変更（0以下なら削除） */
function updateOrderQty(rowNumber, newQty) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const sh = getSheet_(SHEET_ACTIVE, HEADERS_ACTIVE);
    const n = Number(rowNumber);
    if (n < 2 || n > sh.getLastRow()) throw new Error('無効な行番号');
    newQty = Number(newQty) || 0;
    if (newQty <= 0) {
      sh.deleteRow(n);
    } else {
      const price = Number(sh.getRange(n, 3).getValue()) || 0;
      sh.getRange(n, 4).setValue(newQty);
      sh.getRange(n, 5).setValue(price * newQty);
    }
    return getDashboard();
  } finally {
    lock.releaseLock();
  }
}

/** 注文追加 */
function addOrder(seatId, product, price, qty) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    product = String(product || '').trim();
    price = Number(price) || 0;
    qty = Number(qty) || 1;
    if (!product) throw new Error('商品名は必須です');
    if (price < 0) throw new Error('単価が不正です');
    if (qty < 1) throw new Error('数量は1以上');
    _addOrderInternal(String(seatId), product, price, qty);
    return getDashboard();
  } finally {
    lock.releaseLock();
  }
}

/** 1明細を取消 */
function removeOrderItem(rowNumber) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const sh = getSheet_(SHEET_ACTIVE, HEADERS_ACTIVE);
    const n = Number(rowNumber);
    if (n < 2 || n > sh.getLastRow()) throw new Error('無効な行番号');
    sh.deleteRow(n);
    return getDashboard();
  } finally {
    lock.releaseLock();
  }
}

/** 席ごとの伝票（モーダル表示用） */
function getSeatBill(seatId) {
  ensureAllSheets_();
  seatId = String(seatId);
  const states = getSeatStates_();
  const leader = getLeaderOf_(seatId, states);

  const orders = getActiveOrders_().filter(o => o.seatId === leader);
  let subtotal = 0;
  orders.forEach(o => subtotal += o.subtotal);
  const tax = Math.round(subtotal * TAX_RATE);
  const total = subtotal + tax;

  const members = states
    .filter(s => s.seatId === leader || s.groupLeader === leader)
    .map(s => s.seatId).sort();
  let guests = 0;
  states.filter(s => s.seatId === leader || s.groupLeader === leader)
    .forEach(s => guests += s.guests);

  return {
    leader,
    leaderLabel: seatLabel_(leader),
    members,
    membersLabel: members.map(seatLabel_).join('・'),
    guests,
    items: orders,
    subtotal,
    tax,
    total
  };
}

/** カウンター席をグループ化 */
function groupSeats(seatIds) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    if (!Array.isArray(seatIds) || seatIds.length < 2) {
      throw new Error('2席以上を選択してください');
    }
    seatIds = seatIds.map(String);
    if (!seatIds.every(s => COUNTER_SEATS.indexOf(s) >= 0)) {
      throw new Error('グループ化はカウンター席のみ可能です');
    }
    // 重複排除
    seatIds = Array.from(new Set(seatIds));

    const states = getSeatStates_();
    seatIds.forEach(id => {
      const s = states.find(x => x.seatId === id);
      if (s && s.groupLeader && s.groupLeader !== id) {
        throw new Error(id + ' はすでに別グループに属しています');
      }
    });

    // リーダー決定: すでに開いている席があればその最小、なければ最小席
    const sorted = seatIds.slice().sort();
    const openOnes = sorted.filter(id => states.find(s => s.seatId === id));
    const leader = openOnes.length > 0 ? openOnes[0] : sorted[0];

    const seatSh   = getSheet_(SHEET_SEATS,  HEADERS_SEATS);
    const activeSh = getSheet_(SHEET_ACTIVE, HEADERS_ACTIVE);

    seatIds.forEach(id => {
      const s = states.find(x => x.seatId === id);
      const groupVal = (id === leader) ? '' : leader;
      if (s) {
        seatSh.getRange(s.row, 2).setValue(groupVal);
      } else {
        seatSh.appendRow([id, groupVal, 0, new Date()]);
      }
    });

    // 既存注文をリーダーに移管
    const orders = getActiveOrders_();
    orders.forEach(o => {
      if (seatIds.indexOf(o.seatId) >= 0 && o.seatId !== leader) {
        activeSh.getRange(o.row, 1).setValue(leader);
      }
    });

    return getDashboard();
  } finally {
    lock.releaseLock();
  }
}

/** グループ解除（リーダー席のIDを渡す。メンバーを渡してもOK） */
function ungroupSeat(seatId) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    seatId = String(seatId);
    const states = getSeatStates_();
    const leader = getLeaderOf_(seatId, states);

    const members = states.filter(s => s.seatId === leader || s.groupLeader === leader);
    if (members.length < 2) throw new Error('この席はグループではありません');

    const sh = getSheet_(SHEET_SEATS, HEADERS_SEATS);
    const toDelete = [];
    members.forEach(m => {
      if (m.seatId === leader) {
        sh.getRange(m.row, 2).setValue('');
      } else {
        // メンバーは状態削除（注文はリーダーに残る = リーダー席として継続使用）
        toDelete.push(m.row);
      }
    });
    toDelete.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));

    return getDashboard();
  } finally {
    lock.releaseLock();
  }
}

/** 会計：SalesHistory に転記してActiveOrders/SeatStateから削除 */
function checkout(seatId) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    seatId = String(seatId);
    const states = getSeatStates_();
    const leader = getLeaderOf_(seatId, states);

    const orders = getActiveOrders_().filter(o => o.seatId === leader);
    if (orders.length === 0) throw new Error('注文がありません');

    const histSh   = getSheet_(SHEET_HISTORY, HEADERS_HISTORY);
    const activeSh = getSheet_(SHEET_ACTIVE,  HEADERS_ACTIVE);
    const seatSh   = getSheet_(SHEET_SEATS,   HEADERS_SEATS);

    const members = states
      .filter(s => s.seatId === leader || s.groupLeader === leader)
      .map(s => s.seatId).sort();
    const seatLabel = (members.length > 0 ? members : [leader])
      .map(seatLabel_).join('・');

    const now = new Date();
    let total = 0;
    const rows = orders.map(o => {
      const t = Math.round(o.subtotal * (1 + TAX_RATE));
      total += t;
      return [now, seatLabel, o.product, o.price, o.qty, t];
    });
    histSh.getRange(histSh.getLastRow() + 1, 1, rows.length, HEADERS_HISTORY.length)
      .setValues(rows);

    // ActiveOrders から削除
    orders.map(o => o.row).sort((a, b) => b - a)
      .forEach(r => activeSh.deleteRow(r));

    // SeatState から削除（リーダー＋メンバー全部）
    states.filter(s => s.seatId === leader || s.groupLeader === leader)
      .map(s => s.row).sort((a, b) => b - a)
      .forEach(r => seatSh.deleteRow(r));

    return { ok: true, total, seatLabel, dashboard: getDashboard() };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 売上サマリ
// ============================================================
function getSalesSummary_() {
  const sh = getSheet_(SHEET_HISTORY, HEADERS_HISTORY);
  const last = sh.getLastRow();
  if (last <= 1) return { today: 0, week: 0, month: 0 };

  const data = sh.getRange(2, 1, last - 1, HEADERS_HISTORY.length).getValues();

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // 月曜開始
  const dow = startToday.getDay();
  const offset = dow === 0 ? 6 : dow - 1;
  const startWeek = new Date(startToday);
  startWeek.setDate(startWeek.getDate() - offset);
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let today = 0, week = 0, month = 0;
  data.forEach(row => {
    const dt = (row[0] instanceof Date) ? row[0] : new Date(row[0]);
    if (isNaN(dt.getTime())) return;
    const total = Number(row[5]) || 0;
    if (dt >= startMonth) month += total;
    if (dt >= startWeek)  week  += total;
    if (dt >= startToday) today += total;
  });
  return { today, week, month };
}

// ============================================================
// ヘルパ
// ============================================================
function seatLabel_(id) {
  if (!id) return '';
  if (id.charAt(0) === 'C') return 'カウンター' + id.substring(1);
  if (id === 'T')  return 'テーブル';
  if (id === 'TA') return 'A卓'; // 旧データ互換
  if (id === 'TB') return 'B卓'; // 旧データ互換
  return id;
}

// ============================================================
// 動作確認用（GASエディタから手動実行）
// ============================================================
function setupSheets() {
  ensureAllSheets_();
  Logger.log('シートを初期化しました');
}

function debugDashboard() {
  Logger.log(JSON.stringify(getDashboard(), null, 2));
}

// ============================================================
// 売上履歴クリア（テストデータの一掃用）
//   GASエディタから手動実行。SalesHistory のヘッダー以外を消す。
// ============================================================
function clearSalesNow() {
  const sh = getSheet_(SHEET_HISTORY, HEADERS_HISTORY);
  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
    Logger.log('売上履歴を ' + (last - 1) + ' 行クリアしました');
  } else {
    Logger.log('売上履歴は既に空です');
  }
}

// ============================================================
// 売上サマリシートを生成／更新
//   GASエディタから手動実行 → 「売上サマリ」シートが作成・更新される
//   日別 / 週別(月曜開始) / 月別 を1枚にまとめて表示
// ============================================================
function refreshSalesSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const histSh = getSheet_(SHEET_HISTORY, HEADERS_HISTORY);

  let sh = ss.getSheetByName('売上サマリ');
  if (!sh) sh = ss.insertSheet('売上サマリ');
  sh.clear();

  // タイトル
  sh.getRange('A1').setValue('📊 売上サマリ')
    .setFontSize(16).setFontWeight('bold');
  sh.getRange('A2').setValue('最終更新: ' +
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'));

  const last = histSh.getLastRow();
  if (last <= 1) {
    sh.getRange('A4').setValue('売上データがありません');
    Logger.log('売上履歴が空です');
    return;
  }

  const data = histSh.getRange(2, 1, last - 1, HEADERS_HISTORY.length).getValues();

  const byDay = {}, byWeek = {}, byMonth = {};
  data.forEach(r => {
    const dt = (r[0] instanceof Date) ? r[0] : new Date(r[0]);
    if (isNaN(dt.getTime())) return;
    const total = Number(r[5]) || 0;

    const dayKey = Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy-MM-dd');
    byDay[dayKey] = (byDay[dayKey] || 0) + total;

    // 月曜起算の週キー
    const monday = new Date(dt);
    monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    const weekKey = Utilities.formatDate(monday, 'Asia/Tokyo', 'yyyy-MM-dd') + '週';
    byWeek[weekKey] = (byWeek[weekKey] || 0) + total;

    const monthKey = Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy-MM');
    byMonth[monthKey] = (byMonth[monthKey] || 0) + total;
  });

  // 日別 (A列)
  sh.getRange('A4').setValue('📅 日別')
    .setFontSize(12).setFontWeight('bold').setBackground('#fff3cd');
  sh.getRange('A5:B5').setValues([['日付', '売上(税込)']])
    .setFontWeight('bold').setBackground('#f8f9fa');
  const dayKeys = Object.keys(byDay).sort().reverse();
  if (dayKeys.length) {
    sh.getRange(6, 1, dayKeys.length, 2).setValues(dayKeys.map(k => [k, byDay[k]]));
    sh.getRange(6, 2, dayKeys.length, 1).setNumberFormat('¥#,##0');
  }

  // 週別 (D列)
  sh.getRange('D4').setValue('📊 週別(月曜開始)')
    .setFontSize(12).setFontWeight('bold').setBackground('#cfe2ff');
  sh.getRange('D5:E5').setValues([['週', '売上(税込)']])
    .setFontWeight('bold').setBackground('#f8f9fa');
  const weekKeys = Object.keys(byWeek).sort().reverse();
  if (weekKeys.length) {
    sh.getRange(6, 4, weekKeys.length, 2).setValues(weekKeys.map(k => [k, byWeek[k]]));
    sh.getRange(6, 5, weekKeys.length, 1).setNumberFormat('¥#,##0');
  }

  // 月別 (G列)
  sh.getRange('G4').setValue('📈 月別')
    .setFontSize(12).setFontWeight('bold').setBackground('#d1e7dd');
  sh.getRange('G5:H5').setValues([['月', '売上(税込)']])
    .setFontWeight('bold').setBackground('#f8f9fa');
  const monthKeys = Object.keys(byMonth).sort().reverse();
  if (monthKeys.length) {
    sh.getRange(6, 7, monthKeys.length, 2).setValues(monthKeys.map(k => [k, byMonth[k]]));
    sh.getRange(6, 8, monthKeys.length, 1).setNumberFormat('¥#,##0');
  }

  // 列幅調整
  sh.setColumnWidth(1, 120);
  sh.setColumnWidth(2, 110);
  sh.setColumnWidth(3, 20);
  sh.setColumnWidth(4, 130);
  sh.setColumnWidth(5, 110);
  sh.setColumnWidth(6, 20);
  sh.setColumnWidth(7, 90);
  sh.setColumnWidth(8, 110);

  sh.setFrozenRows(5);

  Logger.log('売上サマリを更新しました（日 ' + dayKeys.length +
             ' / 週 ' + weekKeys.length + ' / 月 ' + monthKeys.length + ' 行）');
}

// ============================================================
// 飲料メニュー一括インポート（OTTO飲料メニュー編集用.pptx 準拠）
//   GASエディタから 1回だけ実行してください。
//   既存の Menu シートの中身を全置き換えします（お通しの値段は引き継ぎ）。
// ============================================================
function importDrinkMenu() {
  const sh = getSheet_(SHEET_MENU, HEADERS_MENU);

  // 既存お通しの値段を引き継ぎ（なければデフォルト）
  const existing = getMenu();
  const o = existing.find(m => m.name === OTOSHI_NAME);
  const otoshiPrice = o ? o.price : OTOSHI_DEFAULT_PRICE;

  // ヘッダー以外をクリア
  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  }

  const menu = [
    [OTOSHI_NAME, otoshiPrice, 'お通し'],

    // 芋焼酎
    ['白波',                450, '芋焼酎'],
    ['白波 炭酸割',         500, '芋焼酎'],
    ['黒霧島',              400, '芋焼酎'],
    ['黒霧島 炭酸割',       450, '芋焼酎'],
    ['赤霧島',              450, '芋焼酎'],
    ['赤霧島 炭酸割',       500, '芋焼酎'],
    ['茜霧島',              450, '芋焼酎'],
    ['茜霧島 炭酸割',       500, '芋焼酎'],
    ['三岳',                500, '芋焼酎'],
    ['三岳 炭酸割',         550, '芋焼酎'],
    ['尾鈴山 山ネコ',        450, '芋焼酎'],
    ['尾鈴山 山ネコ 炭酸割', 500, '芋焼酎'],
    ['伊佐美',              600, '芋焼酎'],
    ['伊佐美 炭酸割',       650, '芋焼酎'],

    // 黒糖焼酎
    ['れんと',              400, '黒糖焼酎'],
    ['れんと 炭酸割',       450, '黒糖焼酎'],

    // 麦焼酎
    ['神の河',              400, '麦焼酎'],
    ['神の河 炭酸割',       450, '麦焼酎'],
    ['いいちこ',            400, '麦焼酎'],
    ['いいちこ 炭酸割',     450, '麦焼酎'],
    ['二階堂',              400, '麦焼酎'],
    ['二階堂 炭酸割',       450, '麦焼酎'],
    ['中々',                550, '麦焼酎'],
    ['中々 炭酸割',         600, '麦焼酎'],

    // 焼酎キープ
    ['キープ 芋黒霧島 5合',     2000, '焼酎キープ'],
    ['キープ 芋赤霧島 5合',     2500, '焼酎キープ'],
    ['キープ 芋茜霧島 5合',     2500, '焼酎キープ'],
    ['キープ 芋三岳 5合',       3000, '焼酎キープ'],
    ['キープ 麦いいちこ 5合',   2000, '焼酎キープ'],
    ['キープ 麦二階堂 5合',     2000, '焼酎キープ'],
    ['キープ 芋白波 1升',       3500, '焼酎キープ'],
    ['キープ 芋黒霧島 1升',     3500, '焼酎キープ'],
    ['キープ 芋赤霧島 1升',     4500, '焼酎キープ'],
    ['キープ 芋三岳 1升',       5500, '焼酎キープ'],
    ['キープ 黒糖れんと 1升',   4200, '焼酎キープ'],
    ['キープ 麦いいちこ 1升',   3800, '焼酎キープ'],
    ['キープ 麦二階堂 1升',     3800, '焼酎キープ'],
    ['キープ 麦中々 1升',       7000, '焼酎キープ'],

    // チャージ
    ['チャージ 緑茶/ウーロン茶/水/氷', 200, 'チャージ'],
    ['チャージ 炭酸/氷',               300, 'チャージ'],

    // ビール
    ['生ビール',           380, 'ビール'],
    ['生ビール 大',        550, 'ビール'],

    // 酎ハイ
    ['酎ハイ レモン',      380, '酎ハイ'],
    ['酎ハイ トマト',      380, '酎ハイ'],
    ['酎ハイ カルピス',    380, '酎ハイ'],
    ['酎ハイ ライム',      380, '酎ハイ'],
    ['酎ハイ パイン',      380, '酎ハイ'],
    ['酎ハイ みかん',      380, '酎ハイ'],
    ['酎ハイ 大',          550, '酎ハイ'],

    // ハイボール
    ['ハイボール',         380, 'ハイボール'],
    ['ハイボール 濃いめ',  480, 'ハイボール'],
    ['ハイボール 大',      550, 'ハイボール'],

    // 日本酒
    ['日本酒 徳利 小',     500,  '日本酒'],
    ['日本酒 徳利 大',     1000, '日本酒'],
    ['おでん出し汁割',     350,  '日本酒'],

    // ノンアル
    ['アサヒドライゼロ',   380, 'ノンアル'],

    // ソフトドリンク
    ['コーラ',             250, 'ソフトドリンク'],
    ['ジンジャーエール',   250, 'ソフトドリンク'],
    ['アップルジュース',   250, 'ソフトドリンク'],
    ['オレンジジュース',   250, 'ソフトドリンク'],
    ['カルピス',           250, 'ソフトドリンク'],
    ['ウーロン茶',         250, 'ソフトドリンク'],
    ['緑茶',               250, 'ソフトドリンク'],
    ['梅昆布',             250, 'ソフトドリンク'],

    // ワイン
    ['白ワイン',           4000, 'ワイン'],
    ['赤ワイン',           4000, 'ワイン'],

    // セット
    ['せんべろセット',     1000, 'セット']
  ];

  sh.getRange(2, 1, menu.length, 3).setValues(menu);
  Logger.log('飲料メニュー ' + menu.length + ' 件をインポートしました');
}
