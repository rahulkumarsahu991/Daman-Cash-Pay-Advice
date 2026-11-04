/* =====================================================================
 * DEMO MODE — loaded only when APPS_SCRIPT_URL in config.js is empty.
 * Works like Code.gs, but keeps the data in this browser (localStorage).
 * Starts empty — no sample entries.
 * ===================================================================== */
(function () {
  'use strict';
  const KEY = 'cpa_demo_db_v2';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

  // old demo data (with sample drivers) is no longer used
  try { localStorage.removeItem('cpa_demo_db_v1'); } catch (e) { /* storage blocked */ }

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && Array.isArray(d.rows)) return d;
    } catch (e) { /* fresh start */ }
    return { seq: 0, rows: [] };
  }
  function save(db) {
    try { localStorage.setItem(KEY, JSON.stringify(db)); return true; } catch (e) { return false; }
  }

  function bootstrap(db) {
    const rows = db.rows;
    const map = {};
    rows.forEach(r => {
      let d = map[r.driverId];
      if (!d) d = map[r.driverId] = { id: r.driverId, name: '', mobile: '', vehicles: [], count: 0, total: 0, last: '', lastAmount: 0 };
      d.count++;
      d.total = round2(d.total + r.amount);
      if (r.date >= d.last) { d.last = r.date; d.lastAmount = r.amount; }
      d.name = r.name || d.name;
      d.mobile = r.mobile || d.mobile;
      d.vehicles = [r.vehicle].concat(d.vehicles.filter(v => v !== r.vehicle)).slice(0, 5);
    });
    const drivers = Object.keys(map).map(k => map[k]).sort((a, b) => b.last.localeCompare(a.last));
    const vehicles = [];
    for (let i = rows.length - 1; i >= 0; i--) if (vehicles.indexOf(rows[i].vehicle) < 0) vehicles.push(rows[i].vehicle);
    const t = ymd(new Date());
    const stats = { today: { count: 0, total: 0 }, month: { count: 0, total: 0 }, all: { count: 0, total: 0 }, drivers: drivers.length };
    rows.forEach(r => {
      stats.all.count++; stats.all.total += r.amount;
      if (r.date === t) { stats.today.count++; stats.today.total += r.amount; }
      if (r.date.slice(0, 7) === t.slice(0, 7)) { stats.month.count++; stats.month.total += r.amount; }
    });
    const bySubmit = rows.slice().sort((a, b) => a.at.localeCompare(b.at));
    return { needPin: false, drivers: drivers, vehicles: vehicles, recent: bySubmit.slice(-30).reverse(), stats: stats, today: t, sheetUrl: '', folderUrl: '' };
  }

  function history(db, b) {
    const id = String(b.driverId || '').toUpperCase().replace(/\s+/g, '');
    const q = String(b.q || '').trim().toLowerCase();
    let out;
    if (id) out = db.rows.filter(r => r.driverId === id);
    else if (!q && (b.from || b.to)) out = db.rows.slice(); // every payment in the period
    else {
      if (q.length < 2) throw new Error('Type at least 2 letters to search');
      const qk = q.replace(/[^a-z0-9]/g, '');
      const qd = q.replace(/\D/g, '');
      out = db.rows.filter(r => {
        const did = r.driverId.toLowerCase();
        return did === q || (qk.length >= 2 && did.indexOf(qk) >= 0) || r.name.toLowerCase().indexOf(q) >= 0 ||
          (qd.length >= 4 && qd.length === qk.length && r.mobile.indexOf(qd) >= 0) ||
          (qk.length >= 4 && r.vehicle.toLowerCase().indexOf(qk) >= 0) || r.adviceNo.toLowerCase() === q;
      });
    }
    if (b.from) out = out.filter(r => r.date >= b.from);
    if (b.to) out = out.filter(r => r.date <= b.to);
    out = out.slice().sort((a, c) => (c.date + c.at).localeCompare(a.date + a.at));
    return { rows: out, total: out.length };
  }

  function submit(db, b) {
    const d = b.data || {};
    if (!b.file || !b.file.data) throw new Error('Please attach the receipt photo');
    const now = new Date();
    db.seq = (db.seq || db.rows.length) + 1;
    const row = {
      adviceNo: 'CPA' + String(db.seq).padStart(5, '0'),
      at: ymd(now) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()),
      date: d.date || ymd(now),
      vehicle: d.vehicle, driverId: d.driverId, name: d.name, mobile: d.mobile,
      amount: round2(d.amount), remark: d.remark || '', by: d.by, fileId: '',
      img: b.file.type === 'application/pdf' ? '' : (b.file.data.length < 450000 ? 'data:' + b.file.type + ';base64,' + b.file.data : (b.thumb || ''))
    };
    db.rows.push(row);
    if (!save(db)) { // browser storage full → keep only the small thumbnail
      row.img = b.thumb || '';
      if (!save(db)) { db.rows.pop(); db.seq--; throw new Error('Demo storage is full — clear site data to reset the demo'); }
    }
    return { row: row };
  }

  async function call(b) {
    await sleep(b.action === 'submit' ? 1200 : 350 + Math.random() * 300);
    try {
      const db = load();
      let res;
      switch (b.action) {
        case 'ping': res = { needPin: false }; break;
        case 'login': res = { token: '', boot: bootstrap(db) }; break;
        case 'bootstrap': res = bootstrap(db); break;
        case 'history': res = history(db, b); break;
        case 'submit': res = submit(db, b); break;
        case 'deleteEntry': {
          const i = db.rows.findIndex(r => r.adviceNo === b.adviceNo);
          if (i < 0) throw new Error('Entry ' + b.adviceNo + ' not found — it may already be deleted');
          db.rows.splice(i, 1);
          save(db);
          res = { deleted: b.adviceNo };
          break;
        }
        default: throw new Error('Unknown action: ' + b.action);
      }
      return Object.assign({ ok: true }, JSON.parse(JSON.stringify(res)));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  window.MockAPI = { call: call, reset: () => localStorage.removeItem(KEY) };
})();
