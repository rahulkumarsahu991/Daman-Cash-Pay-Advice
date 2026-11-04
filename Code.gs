/**
 * =====================================================================
 *  DAMAN GROUP — CASH PAY ADVICES
 *  Google Apps Script backend for the website.
 *
 *  Every cash payment given to a driver is saved:
 *    • as one row in the Google Sheet tab "Payments"
 *    • with its receipt photo in Google Drive
 *      (folder "Daman Cash Pay Advices" → one sub-folder per driver)
 *
 *  ONE-TIME SETUP
 *   1. Create a new Google Sheet (name it e.g. "Daman Cash Pay Advices").
 *   2. In the Sheet: Extensions → Apps Script. Delete the sample code,
 *      paste this whole file, click Save.
 *   3. (Optional) fill ACCESS_PIN / DRIVE_FOLDER in CONFIG below.
 *   4. Choose the function "setup" in the toolbar and click ▶ Run.
 *      Allow the permissions Google asks for (Sheet + Drive).
 *   5. Deploy → New deployment → ⚙ Select type: Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      → Deploy → copy the Web app URL (ends with /exec).
 *   6. Paste that URL into config.js → APPS_SCRIPT_URL.
 *
 *  AFTER EDITING THIS FILE LATER
 *   Deploy → Manage deployments → ✏ Edit → Version: "New version" → Deploy.
 *   (The /exec URL stays the same, so config.js does not change.)
 * =====================================================================
 */

const CONFIG = {
  // '' = use the Google Sheet this script is attached to.
  // Or paste a Sheet link / ID to save into another spreadsheet.
  SHEET_ID: '',
  SHEET_NAME: 'Payments',

  // '' = a folder "Daman Cash Pay Advices" is created in your My Drive.
  // Or paste a Drive folder link / ID (this Google account must be able to edit it).
  DRIVE_FOLDER: 'https://drive.google.com/drive/folders/1wwnL3fzbIokh_juyZdTkUz8qEN2MVTL0',
  ROOT_FOLDER_NAME: 'Daman Cash Pay Advices',

  // Access PIN for the website. Staff type it once per phone/computer.
  // '' = no PIN (anyone who has the website link can use it).
  ACCESS_PIN: 'Daman@11',
  SESSION_DAYS: 30,

  // Password asked before an entry can be deleted (only the manager should know it).
  // '' = no password, just a confirmation. Deleted entries are copied to the "Deleted" tab.
  DELETE_PASSWORD: 'Daman@#*11',

  ADVICE_PREFIX: 'CPA',      // Advice numbers: CPA00001, CPA00002 …
  ADVICE_DIGITS: 5,
  MAX_FILE_MB: 10,
  RECENT_COUNT: 30,          // "Latest payments" shown on the History screen
  TZ: 'Asia/Kolkata',

  // Attendance sheet: typing a Vehicle No on the website fills in the driver
  // who is on that vehicle TODAY (Driver ID, Name, Mobile).
  // Layout: B = Driver ID, C = Name, D = Mobile, then for every day a column whose
  // heading is the date (01/10/2026 …) holding that day's Vehicle No.
  // TAB '' = "Attendance <month>" of the current month (Attendance Oct, Attendance Nov …).
  ATTENDANCE: { SHEET_ID: '1wgG2K9phHMQPvIskvXF1OBHxNHFk8pegrKCi0hvuF6U', TAB: '', ID_COL: 2, NAME_COL: 3, MOBILE_COL: 4 },

  // Dispatch sheet: choosing a Vehicle No on the website shows that vehicle's trips
  // (latest first). One row = one trip; VEHICLE_COL = column with the Vehicle No (B = 2).
  DISPATCH: { SHEET_ID: '1EgXBPgwuSJPOcAk9tNtdaDSwYurkG_gAAhdb12wNTHU', TAB: 'DISPATCH SHEET', VEHICLE_COL: 2, TRIPS: 6 },

  // "Parchi pending" sheet: choosing a Vehicle No or typing a Driver ID shows a red flag when a parchi is pending.
  // VEHICLE_COL (J) may hold the full number or just its end (AW7311 matches CG08AW7311).
  // DRIVER_COL (F) is text that contains the Driver ID ("TS 255004 D01557 AW7311").
  // D = amount, H = remark, G = date, A = name. GID = the tab's id, used if the tab is renamed.
  PARCHI: { SHEET_ID: '1uVhxUPKk8Sc4gyzjJBDAs2zuFnKPHI_PpeojCZ_a0Is', TAB: 'Parchi pending', GID: 642523987,
    VEHICLE_COL: 10, AMOUNT_COL: 4, REMARK_COL: 8, DATE_COL: 7, NAME_COL: 1, DRIVER_COL: 6 },

  // Optional: your existing driver list, so a driver's name + mobile fill in
  // automatically from the Driver ID even before his first cash payment.
  // Leave SHEET_ID '' to use only drivers already paid in this sheet.
  DRIVER_MASTER: { SHEET_ID: '', TAB: 'Driver Details', ID_COL: 1, NAME_COL: 2, MOBILE_COL: 3 }
};

const HEADERS = ['Advice No', 'Submitted At', 'Payment Date', 'Vehicle No', 'Driver ID', 'Driver Name',
  'Mobile', 'Amount', 'Remark', 'Uploaded By', 'Receipt', 'File ID', 'Client ID'];

const ACTIONS = {
  ping: () => ({ needPin: !!CONFIG.ACCESS_PIN, time: nowIst_('yyyy-MM-dd HH:mm:ss') }),
  login: login_,
  bootstrap: bootstrap_,
  vehicleDriver: vehicleDriver_,
  // the website's background refresh: today's attendance + pending parchi
  attendance: () => ({ att: attendanceForSite_(attendancePack_()), pending: pendingForSite_(pendingPack_()) }),
  vehicleTrips: vehicleTrips_,
  submit: submit_,
  history: history_,
  deleteEntry: deleteEntry_
};

/* ------------------------------------------------------------------ */
/*  Web app entry points                                               */
/* ------------------------------------------------------------------ */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'ping') return json_(Object.assign({ ok: true, app: 'Daman Cash Pay Advices' }, ACTIONS.ping()));
  return json_({ ok: false, error: 'Please use the website.' });
}

function doPost(e) {
  let b;
  try {
    b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }
  try {
    const fn = ACTIONS[b.action];
    if (!fn) throw err_('Unknown action: ' + b.action);
    if (b.action !== 'ping' && b.action !== 'login') requireAuth_(b);
    return json_(Object.assign({ ok: true }, fn(b)));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err), code: (err && err.code) || '' });
  }
}

/** Run once from the editor: creates the sheet tab + Drive folder and asks for permissions. */
function setup() {
  const ss = ss_();
  ss.setSpreadsheetTimeZone(CONFIG.TZ);
  sheet_();
  const root = rootFolder_();
  Logger.log('✅ Sheet ready:  ' + ss.getUrl());
  Logger.log('✅ Drive folder: ' + root.getUrl());
  Logger.log('Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).');
}

/* ------------------------------------------------------------------ */
/*  Access PIN                                                         */
/* ------------------------------------------------------------------ */

function login_(b) {
  if (!CONFIG.ACCESS_PIN) {
    const out = { token: '' };
    if (b.withData) out.boot = bootstrap_(b);
    return out;
  }
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pin_fails') || 0);
  if (fails >= 20) throw err_('Too many wrong PINs. Please try again after 15 minutes.');
  if (String(b.pin || '').trim() !== String(CONFIG.ACCESS_PIN)) {
    cache.put('pin_fails', String(fails + 1), 900);
    Utilities.sleep(700);
    throw err_('Wrong PIN, please try again', 'PIN');
  }
  const exp = Date.now() + CONFIG.SESSION_DAYS * 86400000;
  const out = { token: exp + '.' + sign_(String(exp)) };
  if (b.withData) out.boot = bootstrap_(b);
  return out;
}

function requireAuth_(b) {
  if (!CONFIG.ACCESS_PIN) return;
  const t = String(b.token || '');
  const i = t.indexOf('.');
  const exp = Number(t.slice(0, i));
  if (i < 1 || !exp || exp < Date.now() || sign_(String(exp)) !== t.slice(i + 1)) {
    throw err_('Please enter the access PIN', 'AUTH');
  }
}

/** HMAC with a random per-script secret + the PIN (changing the PIN logs everyone out). */
function sign_(s) {
  const p = PropertiesService.getScriptProperties();
  let secret = p.getProperty('SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty('SECRET', secret);
  }
  const raw = Utilities.computeHmacSha256Signature(s, secret + '|' + CONFIG.ACCESS_PIN);
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '');
}

/* ------------------------------------------------------------------ */
/*  Bootstrap: driver list, vehicles, latest payments, totals          */
/* ------------------------------------------------------------------ */

function bootstrap_() {
  const rows = readRows_();
  const map = {};
  rows.forEach(r => {
    if (!r.driverId) return;
    let d = map[r.driverId];
    if (!d) d = map[r.driverId] = { id: r.driverId, name: '', mobile: '', vehicles: [], count: 0, total: 0, last: '', lastAmount: 0 };
    d.count++;
    d.total = round2_(d.total + r.amount);
    if (r.date >= d.last) { d.last = r.date; d.lastAmount = r.amount; }
    if (r.name) d.name = r.name;        // rows are in entry order → latest wins
    if (r.mobile) d.mobile = r.mobile;
    if (r.vehicle) d.vehicles = [r.vehicle].concat(d.vehicles.filter(v => v !== r.vehicle)).slice(0, 5);
  });

  masterDrivers_().forEach(m => {
    const d = map[m.id];
    if (!d) map[m.id] = { id: m.id, name: m.name, mobile: m.mobile, vehicles: [], count: 0, total: 0, last: '', lastAmount: 0 };
    else {
      if (!d.name) d.name = m.name;
      if (!d.mobile) d.mobile = m.mobile;
    }
  });

  const drivers = Object.keys(map).map(k => map[k])
    .sort((a, b) => (b.last || '').localeCompare(a.last || '') || a.name.localeCompare(b.name));

  const vehicles = [];
  for (let i = rows.length - 1; i >= 0 && vehicles.length < 800; i--) {
    const v = rows[i].vehicle;
    if (v && vehicles.indexOf(v) < 0) vehicles.push(v);
  }

  const today = nowIst_('yyyy-MM-dd');
  const month = today.slice(0, 7);
  const stats = { today: { count: 0, total: 0 }, month: { count: 0, total: 0 }, all: { count: 0, total: 0 }, drivers: 0 };
  rows.forEach(r => {
    stats.all.count++; stats.all.total += r.amount;
    if (r.date === today) { stats.today.count++; stats.today.total += r.amount; }
    if (r.date.slice(0, 7) === month) { stats.month.count++; stats.month.total += r.amount; }
  });
  ['today', 'month', 'all'].forEach(k => { stats[k].total = round2_(stats[k].total); });
  stats.drivers = drivers.filter(d => d.count > 0).length;

  const p = PropertiesService.getScriptProperties();
  const folderId = CONFIG.DRIVE_FOLDER ? idFrom_(CONFIG.DRIVE_FOLDER) : p.getProperty('ROOT_FOLDER_ID');

  return {
    needPin: !!CONFIG.ACCESS_PIN,
    drivers: drivers,
    vehicles: vehicles,
    recent: rows.slice(-CONFIG.RECENT_COUNT).reverse(),
    stats: stats,
    today: today,
    sheetUrl: ss_().getUrl(),
    folderUrl: folderId ? 'https://drive.google.com/drive/folders/' + folderId : '',
    deleteNeedsPassword: !!CONFIG.DELETE_PASSWORD,
    // today's attendance straight from the cache (fast); null or stale → the website
    // asks for a fresh copy with the "attendance" action in the background
    att: attendanceForSite_(attendancePack_('cached')),
    pending: pendingForSite_(pendingPack_('cached'))
  };
}

/* ------------------------------------------------------------------ */
/*  Parchi pending: vehicles whose parchi has not come yet             */
/* ------------------------------------------------------------------ */

/**
 * { t, error, rows: [[VEHICLE, amount, remark, date, name, text with the Driver ID], …] } as the sheet shows them.
 * Same caching as attendance: kept 6 hours, fresh for 10 minutes; mode 'cached' = cache only.
 */
function pendingPack_(mode) {
  const P = CONFIG.PARCHI || {};
  if (!P.SHEET_ID) return { t: Date.now(), error: '', rows: [] };
  const cache = CacheService.getScriptCache();
  const key = 'parchi2';
  const hit = cache.get(key);
  if (hit) {
    const p = JSON.parse(hit);
    if (mode === 'cached' || Date.now() - p.t < 600000) return p;
  } else if (mode === 'cached') {
    return null;
  }
  const pack = { t: Date.now(), error: '', rows: [] };
  try {
    const book = SpreadsheetApp.openById(idFrom_(P.SHEET_ID));
    let sh = findSheetLoose_(book, P.TAB);
    if (!sh && P.GID) sh = book.getSheets().filter(s => s.getSheetId() === P.GID)[0] || null;
    if (!sh) {
      pack.error = 'Tab "' + P.TAB + '" not found in the parchi pending sheet';
    } else if (sh.getLastRow() >= 2) {
      const width = Math.max(P.VEHICLE_COL, P.AMOUNT_COL, P.REMARK_COL, P.DATE_COL || 1, P.NAME_COL || 1, P.DRIVER_COL || 1);
      sh.getRange(2, 1, sh.getLastRow() - 1, width).getDisplayValues().forEach(r => {
        const cell = c => (c ? String(r[c - 1]).replace(/\s+/g, ' ').trim() : '');
        const veh = cell(P.VEHICLE_COL).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const who = cell(P.DRIVER_COL).toUpperCase();
        if (veh.length < 4 && !who) return;
        pack.rows.push([veh, cell(P.AMOUNT_COL), cell(P.REMARK_COL), cell(P.DATE_COL), cell(P.NAME_COL), who]);
      });
    }
  } catch (e) {
    pack.error = 'Cannot open the parchi pending sheet: ' + (e && e.message ? e.message : e);
  }
  const s = JSON.stringify(pack);
  if (s.length < 95000) cache.put(key, s, 21600);
  return pack;
}

function pendingForSite_(p) {
  return p ? { error: p.error, rows: p.rows, stale: Date.now() - (p.t || 0) > 600000 } : null;
}

/** Compact attendance for the website, with a "stale" flag when older than 10 minutes. */
function attendanceForSite_(p) {
  return p ? { date: p.date, error: p.error, d: p.d, m: p.m, stale: Date.now() - (p.t || 0) > 600000 } : null;
}

/* ------------------------------------------------------------------ */
/*  Attendance: who drives which vehicle today                         */
/* ------------------------------------------------------------------ */

function vehicleDriver_(b) {
  const v = str_(b.vehicle).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const att = attendanceToday_();
  const d = att.map[v];
  return d ? { found: true, driverId: d.id, name: d.name, mobile: d.mobile } : { found: false, note: att.error };
}

/** Today's attendance → { date, error, drivers: [{id,name,mobile}], map: {VEHICLENO: driver} }. */
function attendanceToday_() {
  return unpackAttendance_(attendancePack_());
}

/**
 * Today's attendance in compact form { t, date, error, d: [[id, name, mobile], …], m: { VEHICLENO: index in d } }.
 * Reads only the ID/Name/Mobile columns and today's column (not the whole month).
 * The copy is kept for 6 hours but counts as fresh for 10 minutes.
 * mode 'cached' = whatever is in the cache (any age), null when nothing is;
 * otherwise = the cached copy while fresh, else the sheet is read again.
 */
function attendancePack_(mode) {
  const A = CONFIG.ATTENDANCE || {};
  const today = nowIst_('yyyy-MM-dd');
  if (!A.SHEET_ID) return { t: Date.now(), date: today, error: '', d: [], m: {} };
  const cache = CacheService.getScriptCache();
  const key = 'att3_' + today;
  const hit = cache.get(key);
  if (hit) {
    const p = JSON.parse(hit);
    if (mode === 'cached' || Date.now() - p.t < 600000) return p;
  } else if (mode === 'cached') {
    return null;
  }

  const pack = { t: Date.now(), date: today, error: '', d: [], m: {} };
  try {
    const book = SpreadsheetApp.openById(idFrom_(A.SHEET_ID));
    const tabName = A.TAB || 'Attendance ' + Utilities.formatDate(new Date(), CONFIG.TZ, 'MMM');
    const sh = findSheetLoose_(book, tabName);
    const lastRow = sh ? sh.getLastRow() : 0;
    if (!sh) {
      pack.error = 'Tab "' + tabName + '" not found in the attendance sheet';
    } else if (lastRow >= 2) {
      const tz = book.getSpreadsheetTimeZone();
      const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      let col = -1;
      for (let c = 0; c < header.length && col < 0; c++) {
        if (headerDate_(header[c], tz) === today) col = c;
      }
      if (col < 0) pack.error = 'Today\'s date column not found in "' + sh.getName() + '"';
      const first = Math.min(A.ID_COL, A.NAME_COL, A.MOBILE_COL);
      const width = Math.max(A.ID_COL, A.NAME_COL, A.MOBILE_COL) - first + 1;
      const people = sh.getRange(2, first, lastRow - 1, width).getValues();
      const vehicles = col >= 0 ? sh.getRange(2, col + 1, lastRow - 1, 1).getValues() : [];
      people.forEach((r, i) => {
        const id = str_(r[A.ID_COL - first]).toUpperCase().replace(/\s+/g, '');
        if (!id || id.charAt(0) === '#') return;
        pack.d.push([id, str_(r[A.NAME_COL - first]).replace(/\s+/g, ' '), mobile_(r[A.MOBILE_COL - first])]);
        const veh = vehicles[i] ? str_(vehicles[i][0]).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
        if (veh.length >= 4) pack.m[veh] = pack.d.length - 1;
      });
    }
  } catch (e) {
    pack.error = 'Cannot open the attendance sheet: ' + (e && e.message ? e.message : e);
  }
  const s = JSON.stringify(pack);
  if (s.length < 95000) cache.put(key, s, 21600);
  return pack;
}

function unpackAttendance_(p) {
  const drivers = p.d.map(x => ({ id: x[0], name: x[1], mobile: x[2] }));
  const map = {};
  Object.keys(p.m).forEach(v => { map[v] = drivers[p.m[v]]; });
  return { date: p.date, error: p.error, drivers: drivers, map: map };
}

/* ------------------------------------------------------------------ */
/*  Dispatch: the trips of one vehicle                                 */
/* ------------------------------------------------------------------ */

/**
 * { vehicle, headers: [...], trips: [[cell, …], …] newest first, total, note }.
 * Reads the Vehicle No column once, then only that vehicle's last few rows
 * (as the sheet shows them), and keeps the answer for 10 minutes.
 */
function vehicleTrips_(b) {
  const v = str_(b.vehicle).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const D = CONFIG.DISPATCH || {};
  const out = { vehicle: v, headers: [], trips: [], total: 0, note: '' };
  if (v.length < 4 || !D.SHEET_ID) return out;
  const cache = CacheService.getScriptCache();
  const key = 'trips_' + v;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  try {
    const book = SpreadsheetApp.openById(idFrom_(D.SHEET_ID));
    const sh = findSheetLoose_(book, D.TAB);
    const last = sh ? sh.getLastRow() : 0;
    if (!sh) {
      out.note = 'Tab "' + D.TAB + '" not found in the dispatch sheet';
    } else if (last >= 2) {
      const lastCol = sh.getLastColumn();
      out.headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(h => String(h).replace(/\s+/g, ' ').trim());
      const rows = [];
      sh.getRange(2, D.VEHICLE_COL, last - 1, 1).getDisplayValues().forEach((r, i) => {
        if (String(r[0]).toUpperCase().replace(/[^A-Z0-9]/g, '') === v) rows.push(i + 2);
      });
      out.total = rows.length;
      rows.slice(-(D.TRIPS || 6)).reverse().forEach(n => {
        out.trips.push(sh.getRange(n, 1, 1, lastCol).getDisplayValues()[0]);
      });
    }
  } catch (e) {
    out.note = 'Cannot open the dispatch sheet: ' + (e && e.message ? e.message : e);
  }
  const s = JSON.stringify(out);
  if (s.length < 95000) cache.put(key, s, 600);
  return out;
}

/** A date heading (a real date, "13/10/2026", "2026-10-13" or "13-Oct-2026") → 'yyyy-MM-dd'. */
function headerDate_(h, tz) {
  if (h instanceof Date) return isNaN(h.getTime()) ? '' : Utilities.formatDate(h, tz, 'yyyy-MM-dd');
  const s = str_(h);
  if (!s) return '';
  const m = s.match(/^(\d{1,2})[\s\-\/.]*([A-Za-z]{3})[a-z]*[\s\-\/.,]*(\d{2,4})?$/);
  if (m) {
    const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(m[2].toUpperCase());
    if (mon < 0) return '';
    const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : nowIst_('yyyy');
    return y + '-' + ('0' + (mon + 1)).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  const d = dateStr_(s, tz, 'yyyy-MM-dd');
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

/** Sheet by name; also matches when only case / spaces differ. */
function findSheetLoose_(book, name) {
  const exact = book.getSheetByName(name);
  if (exact) return exact;
  const want = String(name).toUpperCase().replace(/\s+/g, '');
  const all = book.getSheets();
  for (let i = 0; i < all.length; i++) {
    if (all[i].getName().toUpperCase().replace(/\s+/g, '') === want) return all[i];
  }
  return null;
}

/** Optional external driver list (CONFIG.DRIVER_MASTER), cached for 6 hours. */
function masterDrivers_() {
  const M = CONFIG.DRIVER_MASTER || {};
  if (!M.SHEET_ID) return [];
  const cache = CacheService.getScriptCache();
  const hit = cache.get('driver_master');
  if (hit) return JSON.parse(hit);
  let list = [];
  try {
    const book = SpreadsheetApp.openById(idFrom_(M.SHEET_ID));
    const sh = M.TAB ? book.getSheetByName(M.TAB) : book.getSheets()[0];
    if (sh && sh.getLastRow() > 1) {
      const width = Math.max(M.ID_COL, M.NAME_COL, M.MOBILE_COL);
      list = sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues()
        .map(v => ({
          id: str_(v[M.ID_COL - 1]).toUpperCase(),
          name: str_(v[M.NAME_COL - 1]).replace(/\s+/g, ' '),
          mobile: mobile_(v[M.MOBILE_COL - 1])
        }))
        .filter(d => d.id && d.name);
    }
  } catch (e) {
    return []; // master sheet not reachable — the site still works without it
  }
  const s = JSON.stringify(list);
  if (s.length < 95000) cache.put('driver_master', s, 21600);
  return list;
}

/* ------------------------------------------------------------------ */
/*  Submit a payment                                                   */
/* ------------------------------------------------------------------ */

function submit_(b) {
  const d = b.data || {};
  const v = {
    vehicle: str_(d.vehicle).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    driverId: str_(d.driverId).toUpperCase().replace(/\s+/g, ''),
    name: str_(d.name).replace(/\s+/g, ' ').slice(0, 80),
    mobile: mobile_(d.mobile),
    amount: round2_(Number(d.amount)),
    date: str_(d.date),
    remark: str_(d.remark).slice(0, 500),
    by: str_(d.by).replace(/\s+/g, ' ').slice(0, 60)
  };
  if (v.vehicle.length < 4) throw err_('Enter a valid vehicle number');
  if (v.name.length < 2) throw err_('Enter the driver name');
  // Driver ID and Mobile are optional; a mobile that is given must be complete
  if (v.mobile && !/^\d{10}$/.test(v.mobile)) throw err_('Mobile number must be 10 digits (or leave it empty)');
  if (!(v.amount > 0) || v.amount > 100000000) throw err_('Enter a valid amount');
  if (!v.by) throw err_('Enter your name (who is uploading the receipt)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) v.date = nowIst_('yyyy-MM-dd');

  const f = b.file || {};
  if (!f.data) throw err_('Please attach the receipt photo');
  const bytes = Utilities.base64Decode(String(f.data));
  if (bytes.length > CONFIG.MAX_FILE_MB * 1048576) throw err_('Receipt file is too big (max ' + CONFIG.MAX_FILE_MB + ' MB)');
  const mime = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/.test(f.type) ? f.type : 'image/jpeg';
  const ext = mime === 'application/pdf' ? 'pdf' : (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');

  // the same submit sent twice (slow network → retry) is saved only once
  const clientId = str_(b.clientId).slice(0, 64);
  const cache = CacheService.getScriptCache();
  if (clientId) {
    const prev = cache.get('cid_' + clientId);
    if (prev) return JSON.parse(prev);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (clientId) {
      const prev = cache.get('cid_' + clientId);
      if (prev) return JSON.parse(prev);
    }
    const sh = sheet_();
    const adviceNo = nextAdviceNo_(sh);
    const fileName = [adviceNo, v.date, v.vehicle, 'Rs' + v.amount].join('_') + '.' + ext;
    const blob = Utilities.newBlob(bytes, mime, fileName);
    DRIVE_NOTE_ = '';
    let folder, file;
    try {
      folder = driverFolder_(v.driverId, v.name);
      file = folder.createFile(blob);
    } catch (e) {
      if (!CONFIG.DRIVE_FOLDER) throw e;
      // e.g. only "Viewer" access to the chosen folder → keep the receipt in the default folder
      DRIVE_NOTE_ = 'No permission to add files to the chosen Drive folder — share it as Editor with the Apps Script account';
      Logger.log('⚠ ' + DRIVE_NOTE_ + ': ' + (e && e.message ? e.message : e));
      folder = driverFolder_(v.driverId, v.name, true);
      file = folder.createFile(blob);
    }
    let savedIn = folder.getName();
    try { savedIn = folder.getParents().next().getName() + ' / ' + savedIn; } catch (e) { /* name of the driver folder is enough */ }
    // "anyone with the link can view" — needed for the receipt previews on the website
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    const url = 'https://drive.google.com/file/d/' + file.getId() + '/view';

    const tz = ss_().getSpreadsheetTimeZone();
    const row = [
      adviceNo,
      new Date(),
      Utilities.parseDate(v.date, tz, 'yyyy-MM-dd'),
      v.vehicle,
      text_(v.driverId),
      text_(v.name),
      v.mobile,
      v.amount,
      text_(v.remark),
      text_(v.by),
      '=HYPERLINK("' + url + '","View receipt")',
      file.getId(),
      clientId
    ];
    sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();

    const out = {
      row: {
        adviceNo: adviceNo, at: nowIst_('yyyy-MM-dd HH:mm'), date: v.date, vehicle: v.vehicle,
        driverId: v.driverId, name: v.name, mobile: v.mobile, amount: v.amount,
        remark: v.remark, by: v.by, fileId: file.getId(),
        savedIn: savedIn,      // "<folder> / <driver folder>" — shown on the PAID slip
        driveNote: DRIVE_NOTE_ // why the chosen DRIVE_FOLDER was not used ('' = it was)
      }
    };
    if (clientId) cache.put('cid_' + clientId, JSON.stringify(out), 21600);
    return out;
  } finally {
    lock.releaseLock();
  }
}

function nextAdviceNo_(sh) {
  const p = PropertiesService.getScriptProperties();
  let n = Number(p.getProperty('ADVICE_SEQ') || 0);
  if (!n) { // first payment (or properties were reset): continue after the highest number in the sheet
    const last = sh.getLastRow();
    if (last > 1) {
      sh.getRange(2, 1, last - 1, 1).getValues().forEach(r => {
        const m = String(r[0]).match(/(\d+)\s*$/);
        if (m) n = Math.max(n, Number(m[1]));
      });
    }
  }
  n++;
  p.setProperty('ADVICE_SEQ', String(n));
  return CONFIG.ADVICE_PREFIX + String(n).padStart(CONFIG.ADVICE_DIGITS, '0');
}

/* ------------------------------------------------------------------ */
/*  History search                                                     */
/* ------------------------------------------------------------------ */

function history_(b) {
  const rows = readRows_();
  const id = str_(b.driverId).toUpperCase().replace(/\s+/g, '');
  let out;
  if (id) {
    out = rows.filter(r => r.driverId === id);
  } else {
    const q = str_(b.q).toLowerCase();
    if (q.length < 2) throw err_('Type at least 2 letters to search');
    const qk = q.replace(/[^a-z0-9]/g, '');
    const qd = q.replace(/\D/g, '');
    out = rows.filter(r => {
      const did = r.driverId.toLowerCase();
      return did === q || (qk.length >= 2 && did.replace(/[^a-z0-9]/g, '').indexOf(qk) >= 0) ||
        r.name.toLowerCase().indexOf(q) >= 0 ||
        (qd.length >= 4 && qd.length === qk.length && r.mobile.indexOf(qd) >= 0) ||
        (qk.length >= 4 && r.vehicle.toLowerCase().indexOf(qk) >= 0) ||
        r.adviceNo.toLowerCase() === q;
    });
  }
  out.sort((a, c) => (c.date + c.at).localeCompare(a.date + a.at));
  return { rows: out.slice(0, 3000), total: out.length };
}

/* ------------------------------------------------------------------ */
/*  Delete an entry (a copy goes to the "Deleted" tab)                 */
/* ------------------------------------------------------------------ */

function deleteEntry_(b) {
  const no = str_(b.adviceNo).toUpperCase();
  if (!no) throw err_('Missing advice number');
  const who = str_(b.by).replace(/\s+/g, ' ').slice(0, 60);
  if (!who) throw err_('Enter your name');
  if (CONFIG.DELETE_PASSWORD && String(b.password || '') !== String(CONFIG.DELETE_PASSWORD)) {
    Utilities.sleep(600);
    throw err_('Wrong delete password', 'DELPW');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = sheet_();
    const last = sh.getLastRow();
    const cell = last > 1 ? sh.getRange(2, 1, last - 1, 1).createTextFinder(no).matchEntireCell(true).findNext() : null;
    if (!cell) throw err_('Entry ' + no + ' not found — it may already be deleted');
    const r = cell.getRow();
    const range = sh.getRange(r, 1, 1, HEADERS.length);
    const values = range.getValues()[0];
    const formulas = range.getFormulas()[0];
    // keep the receipt link formula; protect typed text that starts with = + - @
    const copy = values.map((v, i) => formulas[i] || (typeof v === 'string' ? text_(v) : v));
    deletedSheet_().appendRow(copy.concat([new Date(), text_(who)]));
    sh.deleteRow(r);
    return { deleted: no };
  } finally {
    lock.releaseLock();
  }
}

function deletedSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName('Deleted');
  if (!sh) {
    sh = ss.insertSheet('Deleted');
    const head = HEADERS.concat(['Deleted At', 'Deleted By']);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#c8281e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange('B:C').setNumberFormat('dd-mmm-yyyy hh:mm');
    sh.getRange('C:C').setNumberFormat('dd-mmm-yyyy');
    sh.getRange('E:E').setNumberFormat('@');
    sh.getRange('G:G').setNumberFormat('@');
    sh.getRange('H:H').setNumberFormat('₹#,##0.00');
    sh.getRange('N:N').setNumberFormat('dd-mmm-yyyy hh:mm');
  }
  return sh;
}

/* ------------------------------------------------------------------ */
/*  Sheet helpers                                                      */
/* ------------------------------------------------------------------ */

let SS_ = null;
function ss_() {
  if (!SS_) SS_ = CONFIG.SHEET_ID ? SpreadsheetApp.openById(idFrom_(CONFIG.SHEET_ID)) : SpreadsheetApp.getActiveSpreadsheet();
  if (!SS_) throw err_('Spreadsheet not found — open Apps Script from the Google Sheet (Extensions → Apps Script) or set SHEET_ID');
  return SS_;
}

function sheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#1b1e4f').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('dd-mmm-yyyy hh:mm');
    sh.getRange('C:C').setNumberFormat('dd-mmm-yyyy');
    sh.getRange('E:E').setNumberFormat('@');
    sh.getRange('G:G').setNumberFormat('@');
    sh.getRange('H:H').setNumberFormat('₹#,##0.00');
    [95, 135, 110, 120, 95, 170, 110, 100, 260, 140, 110, 120, 120].forEach((w, i) => sh.setColumnWidth(i + 1, w));
    sh.getRange(1, 1, 1, HEADERS.length).setHorizontalAlignment('center');
  }
  return sh;
}

function readRows_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = ss_().getSpreadsheetTimeZone();
  const vals = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!str_(v[0]) && !str_(v[4])) continue;
    out.push({
      adviceNo: str_(v[0]),
      at: dateStr_(v[1], tz, 'yyyy-MM-dd HH:mm'),
      date: dateStr_(v[2], tz, 'yyyy-MM-dd') || dateStr_(v[1], tz, 'yyyy-MM-dd'),
      vehicle: str_(v[3]).toUpperCase().replace(/[^A-Z0-9]/g, ''),
      driverId: str_(v[4]).toUpperCase().replace(/\s+/g, ''),
      name: str_(v[5]).replace(/\s+/g, ' '),
      mobile: mobile_(v[6]),
      amount: num_(v[7]),
      remark: str_(v[8]),
      by: str_(v[9]),
      fileId: str_(v[11])
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Drive helpers                                                      */
/* ------------------------------------------------------------------ */

// why the chosen DRIVE_FOLDER was not used for this request ('' = it was used)
let DRIVE_NOTE_ = '';

/** The folder receipts go into. useDefault = skip DRIVE_FOLDER and use "Daman Cash Pay Advices" in My Drive. */
function rootFolder_(useDefault) {
  if (CONFIG.DRIVE_FOLDER && !useDefault) {
    try {
      const f = DriveApp.getFolderById(idFrom_(CONFIG.DRIVE_FOLDER));
      if (!f.isTrashed()) return f;
      DRIVE_NOTE_ = 'The chosen Drive folder is in the trash';
    } catch (e) {
      DRIVE_NOTE_ = 'The chosen Drive folder could not be opened — check the link, and share it as Editor with the Apps Script account';
    }
    // never lose a payment because of the folder: use the default folder instead
    Logger.log('⚠ ' + DRIVE_NOTE_ + ' — using "' + CONFIG.ROOT_FOLDER_NAME + '" in My Drive instead');
  }
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('ROOT_FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* deleted — make a new one */ }
  }
  const it = DriveApp.getFoldersByName(CONFIG.ROOT_FOLDER_NAME);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
  p.setProperty('ROOT_FOLDER_ID', f.getId());
  return f;

}

/** "<root>/<DRIVER ID> - <Name>" — one folder per driver ("<root>/<Name>" when there is no ID). */
function driverFolder_(driverId, name, useDefault) {
  const root = rootFolder_(useDefault);
  const p = PropertiesService.getScriptProperties();
  const who = driverId || 'NAME_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const key = 'DF_' + root.getId().slice(-8) + '_' + who.slice(0, 60);
  const id = p.getProperty(key);
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* folder deleted */ }
  }
  const clean = s => s.replace(/[\\/:*?"<>|]/g, ' ');
  const label = clean(driverId ? driverId + ' - ' + name : name).slice(0, 120);
  const prefix = driverId ? clean(driverId + ' - ') : '';
  let folder = null;
  const it = root.searchFolders('title contains "' + (driverId || name).replace(/["\\]/g, '') + '" and trashed = false');
  while (it.hasNext() && !folder) {
    const f = it.next();
    const n = f.getName();
    if (prefix ? n.indexOf(prefix) === 0 : n.toUpperCase() === label.toUpperCase()) folder = f;
  }
  if (!folder) folder = root.createFolder(label);
  p.setProperty(key, folder.getId());
  return folder;
}

/* ------------------------------------------------------------------ */
/*  Small utilities                                                    */
/* ------------------------------------------------------------------ */

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function err_(msg, code) {
  const e = new Error(msg);
  e.code = code || '';
  return e;
}
function str_(v) { return v == null ? '' : String(v).trim(); }
function num_(v) {
  if (typeof v === 'number') return round2_(v);
  return round2_(Number(String(v || '').replace(/[^\d.\-]/g, '')) || 0);
}
function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function mobile_(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length > 10) d = d.replace(/^(91|0)/, '');
  return d.slice(-10);
}
/** Text that starts with = + - @ would become a formula in the Sheet. */
function text_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }
function nowIst_(fmt) { return Utilities.formatDate(new Date(), CONFIG.TZ, fmt); }
function idFrom_(s) {
  s = String(s || '').trim();
  const m = s.match(/(?:\/d\/|\/folders\/|[?&]id=)([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : s;
}
/** Cell → 'yyyy-MM-dd' (or with time). Also understands dates typed by hand (dd/mm/yyyy). */
function dateStr_(v, tz, fmt) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz, fmt);
  const s = str_(v);
  if (!s) return '';
  const two = n => ('0' + n).slice(-2);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + two(m[2]) + '-' + two(m[3]) + (fmt.length > 10 ? s.slice(m[0].length) : '');
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + two(m[2]) + '-' + two(m[1]);
  return s;
}
