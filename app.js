/* =====================================================================
 * Daman Group — Cash Pay Advices · front-end
 * Tab 1: payment form + receipt photo.  Tab 2: driver payment history.
 * Talks to Code.gs (Google Apps Script Web App) with POST text/plain JSON
 * (text/plain keeps it a "simple" request, so the browser sends no CORS preflight).
 * ===================================================================== */
(function () {
  'use strict';

  const CFG = window.CPA_CONFIG || {};
  const API_URL = String(CFG.APPS_SCRIPT_URL || '').trim();
  const DEMO = !API_URL;
  const K = { token: 'cpa_token_v1', boot: 'cpa_boot_v3' };
  const PHOTO_MAX = 1600;      // px, longest side
  const PHOTO_Q = 0.82;        // JPEG quality
  const MAX_MB = 10;
  const RETRYABLE = { bootstrap: 1, history: 1, attendance: 1, vehicleTrips: 1 };
  const FIELDS = ['vehicle', 'driverId', 'name', 'mobile', 'amount', 'remark', 'by'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ---------------- helpers ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = n => '<svg class="i" aria-hidden="true"><use href="#i-' + n + '"/></svg>';
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => ymd(new Date());
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : (s || '');
  }
  function initials(name) {
    const p = String(name || '?').trim().split(/\s+/);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  function inr(n) {
    n = Number(n) || 0;
    return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  const driveThumb = (id, w) => 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w' + w;
  const driveView = id => 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/view';
  const imgUrl = (r, w) => r.img || (r.fileId ? driveThumb(r.fileId, w) : '');
  /** Small yellow number plate — nothing when the entry has no vehicle. */
  const vnoTag = v => (v ? '<span class="vno">' + esc(v) + '</span>' : '');

  /* ---------------- state ---------------- */
  const S = {
    token: store.get(K.token) || '',
    drivers: {}, list: [], recent: [], booted: false,
    photo: null, photoBusy: false, clientId: null, busy: false,
    hist: null, viewRows: []
  };

  /* ---------------- API ---------------- */
  async function postText(body, timeoutMs, keepalive) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        keepalive: !!keepalive, // finishes even if the page is closed right after (small requests only)
        signal: ctrl ? ctrl.signal : undefined
      });
      return await r.text();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function api(action, payload, opts) {
    const body = Object.assign({ action: action, token: S.token }, payload || {});
    let res;
    if (DEMO) {
      res = await window.MockAPI.call(body);
    } else {
      const retry = !!RETRYABLE[action];
      const keepalive = !!(opts && opts.keepalive);
      let text = null, lastErr = null;
      for (let i = 0; i < (retry ? 2 : 1) && text == null; i++) {
        const ms = (opts && opts.timeout) || (retry ? 30000 : 180000);
        try { text = await postText(body, ms, keepalive); } catch (e) { lastErr = e; }
      }
      if (text == null) {
        throw new Error(lastErr && lastErr.name === 'AbortError'
          ? 'Server is taking too long — please try again'
          : 'No internet connection — please check and try again');
      }
      try { res = JSON.parse(text); } catch (e) {
        throw new Error('Invalid reply from server — check the Apps Script deployment (Who has access: Anyone)');
      }
    }
    if (!res || !res.ok) {
      const err = new Error((res && res.error) || 'Something went wrong, please try again');
      err.code = (res && res.code) || '';
      throw err;
    }
    return res;
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 5000 : 3000);
  }

  /* ---------------- popups (phone "back" closes the top one) ---------------- */
  const stack = [];
  /** rAF is paused in background tabs, so a timer makes sure a popup never stays invisible. */
  function fadeIn(el) {
    const show = () => { if (!el.hidden) el.classList.add('show'); };
    requestAnimationFrame(() => requestAnimationFrame(show));
    setTimeout(show, 60);
  }
  function fadeOut(el) {
    el.classList.remove('show');
    setTimeout(() => { if (!el.classList.contains('show')) el.hidden = true; }, 200);
  }
  function openPopup(el) {
    el.hidden = false;
    fadeIn(el);
    stack.push(el);
    document.body.classList.add('noscroll');
    try { history.pushState({ ov: stack.length }, ''); } catch (e) { /* ignore */ }
  }
  function hideTop() {
    const el = stack.pop();
    if (el) fadeOut(el);
    if (!stack.length) document.body.classList.remove('noscroll');
  }
  function closePopup() {
    if (!stack.length) return;
    if (history.state && history.state.ov) history.back();
    else hideTop();
  }
  window.addEventListener('popstate', hideTop);
  document.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { e.preventDefault(); closePopup(); return; }
    if (e.target.classList && e.target.classList.contains('ov') && e.target.id !== 'savingOv') closePopup();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });

  /* ---------------- tabs ---------------- */
  function setView(v) {
    if (v !== 'pay' && v !== 'history') v = 'pay';
    document.body.dataset.view = v;
    $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === v)));
    try { history.replaceState(history.state, '', v === 'history' ? '#history' : '#pay'); } catch (e) { /* ignore */ }
  }
  $$('.tab').forEach(t => t.addEventListener('click', () => { setView(t.dataset.view); window.scrollTo(0, 0); }));

  /* ---------------- start-up data (drivers for auto-fill, recent payments) ---------------- */
  function applyBoot(r) {
    S.list = r.drivers || [];
    S.drivers = {};
    S.list.forEach(d => { S.drivers[d.id] = d; });
    S.recent = r.recent || [];
    S.vehicles = r.vehicles || [];   // vehicles paid before
    S.needPin = !!r.needPin;
    S.delNeedsPw = !!r.deleteNeedsPassword;
    if (r.att) applyAtt(r.att);
    else if (r.attendance) applyAtt({ map: r.attendance, date: r.attendanceDate, error: r.attendanceNote }); // older Code.gs
    else if (r.att === null && S.attDate !== today()) applyAtt(null);
    else mergeAttDrivers();
    if (r.pending) applyPending(r.pending); // null = not cached on the server yet → keep what this device had
    S.booted = true;
    if (!S.hist) renderRecent();
    afterAttendance();
  }
  /** Today's attendance (compact form from Code.gs) → S.att = { VEHICLENO: { id, name, mobile } }. */
  function applyAtt(p) {
    S.attPack = p || null;
    if (!p) { S.att = {}; S.attDrivers = []; S.attDate = ''; S.attNote = ''; return; }
    if (p.map) {
      S.att = p.map;
      S.attDrivers = Object.keys(p.map).map(v => p.map[v]);
    } else {
      S.attDrivers = (p.d || []).map(x => ({ id: x[0], name: x[1], mobile: x[2] }));
      S.att = {};
      Object.keys(p.m || {}).forEach(v => { S.att[v] = S.attDrivers[p.m[v]]; });
    }
    S.attDate = p.date || '';
    S.attNote = p.error || '';
    if (p.v && p.v.length) S.fleet = p.v; // every vehicle number ("Calling Sheet" column C)
    mergeAttDrivers();
  }
  /** Vehicle numbers for suggestions: the Calling Sheet list; until that has arrived, today's attendance + paid before. */
  function vehicleList() {
    if (S.fleet && S.fleet.length) return S.fleet;
    const seen = {};
    return Object.keys(S.att || {}).concat(S.vehicles || []).filter(v => v && !seen[v] && (seen[v] = 1));
  }
  /** Attendance drivers also fill in name + mobile when a Driver ID is typed. */
  function mergeAttDrivers() {
    (S.attDrivers || []).forEach(m => {
      const d = S.drivers[m.id];
      if (!d) S.drivers[m.id] = { id: m.id, name: m.name, mobile: m.mobile, count: 0, total: 0 };
      else { if (!d.name) d.name = m.name; if (!d.mobile) d.mobile = m.mobile; }
    });
  }
  function afterAttendance() {
    // a real vehicle number as the example in the box
    const sample = vehicleList()[0];
    if (sample) F.vehicle.placeholder = sample;
    // a vehicle typed before the list arrived gets its driver now
    if (F.vehicle.value && !F.driverId.value) lookupVehicle(true);
  }
  function saveBoot() {
    store.set(K.boot, { demo: DEMO, r: { drivers: S.list, recent: S.recent, vehicles: S.vehicles, att: S.attPack,
      pending: S.pendingPack, needPin: S.needPin, deleteNeedsPassword: S.delNeedsPw } });
  }
  /** "Parchi pending" rows: [[VEHICLE (or its end), amount, remark, date, name], …]. */
  function applyPending(p) {
    S.pendingPack = p;
    S.pending = (p && p.rows) || [];
  }
  /** Pending parchi of one vehicle; the sheet often has only the end of the number (AW7311 → CG08AW7311). */
  function pendingFor(v) {
    if (!v || v.length < 4) return [];
    return (S.pending || []).filter(p => p[0] && (v === p[0] || (p[0].length >= 4 && v.slice(-p[0].length) === p[0])));
  }
  /** Pending parchi of one driver: the sheet's text column holds the Driver ID ("TS 255004 D01557 AW7311"). */
  function pendingForDriver(id) {
    id = String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (id.length < 3) return [];
    return (S.pending || []).filter(p => p[5] && (' ' + p[5].replace(/[^A-Z0-9]+/g, ' ') + ' ').indexOf(' ' + id + ' ') >= 0);
  }
  /** The red "Parchi pending" box for a list of rows. */
  function pendingHtml(list) {
    const money = a => {
      const n = parseFloat(String(a).replace(/[^\d.\-]/g, ''));
      return isNaN(n) ? esc(a) : (n < 0 ? '−' : '') + inr(Math.abs(n));
    };
    return '<div class="pending-h">' + icon('flag') + 'Parchi pending</div>' +
      list.map(p => '<div class="pend-row">' +
        (p[1] ? '<span class="pend-amt">Amount ' + money(p[1]) + '</span>' : '') + esc(p[2] || 'Parchi pending') +
        ((p[3] || p[4]) ? '<small>' + esc([p[3], p[4]].filter(Boolean).join(' · ')) + '</small>' : '') +
        '</div>').join('');
  }
  let bootPromise = null;
  function loadBoot() {
    bootPromise = (async () => {
      try {
        const r = await api('bootstrap');
        applyBoot(r);
        if (r.att && !r.att.stale) S.attFetched = Date.now(); // the server's copy is less than 10 minutes old
        saveBoot();
        // the server had no fresh attendance / pending list → fetch them in the background (the page is usable already)
        const old = x => x === null || (x && x.stale);
        if (old(r.att) || old(r.pending)) loadAttendance();
      } catch (e) {
        if (e.code === 'AUTH') return showPin();
        if (!S.booted) { S.bootError = e.message; renderRecent(); }
      }
    })();
    return bootPromise;
  }
  let attPromise = null;
  function loadAttendance() {
    attPromise = api('attendance').then(r => {
      if (r.pending) applyPending(r.pending);
      if (r.att) { applyAtt(r.att); S.attFetched = Date.now(); }
      saveBoot();
      renderPending();
      if (r.att) afterAttendance();
    }).catch(e => { if (e.code === 'AUTH') showPin(); });
    return attPromise;
  }
  /** A saved login that is still valid (the token starts with its expiry time). */
  function tokenAlive() {
    const exp = Number(String(S.token || '').split('.')[0]);
    return exp > Date.now() + 60000;
  }

  /* ---------------- PIN (only when ACCESS_PIN is set in Code.gs) ---------------- */
  let pinRetry = null;
  let warmed = false;
  function showPin(retry) {
    if (DEMO) return;
    if (retry) pinRetry = retry;
    $('#pinScreen').hidden = false;
    $('#pinErr').textContent = '';
    setTimeout(() => $('#pinIn').focus(), 60);
    // wake Google up while the PIN is being typed, so "Open" answers faster
    if (!warmed) {
      warmed = true;
      try { fetch(API_URL + '?action=ping', { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); } catch (e) { /* ignore */ }
    }
  }
  $('#pinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pin = $('#pinIn').value.trim();
    if (!pin) { $('#pinErr').textContent = 'Enter the PIN'; return; }
    const btn = $('#pinBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      // only the PIN check — the page opens at once and its data loads in the background
      const r = await api('login', { pin: pin });
      S.token = r.token || '';
      store.set(K.token, S.token);
      $('#pinScreen').hidden = true;
      $('#pinIn').value = '';
      loadBoot();
      const again = pinRetry;
      pinRetry = null;
      if (again) again();
    } catch (err) {
      $('#pinErr').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Open';
    }
  });

  /* ---------------- suggestion list under an input (inside a .ac box) ---------------- */
  function suggestBox(input, find, itemHtml, onPick) {
    const box = document.createElement('div');
    box.className = 'sugg';
    box.hidden = true;
    input.closest('.ac').appendChild(box);
    let items = [];
    let active = -1;
    function render() {
      items = document.activeElement === input ? find(input.value) : [];
      if (!items.length) { box.hidden = true; return; }
      box.innerHTML = items.map((it, i) =>
        '<button type="button" data-i="' + i + '" class="' + (i === active ? 'on' : '') + '">' + itemHtml(it, input.value) + '</button>').join('');
      box.hidden = false;
    }
    function pick(it) { box.hidden = true; active = -1; onPick(it); }
    input.addEventListener('input', () => { active = -1; render(); });
    input.addEventListener('focus', render);
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
    input.addEventListener('keydown', e => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        render();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        pick(items[active]);
      } else if (e.key === 'Escape') {
        box.hidden = true;
      }
    });
    box.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the input
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-i]');
      if (b) pick(items[+b.dataset.i]);
    });
    return { close() { box.hidden = true; } };
  }
  /** Text with the typed part marked. */
  function mark(text, q) {
    const i = q ? text.indexOf(q) : -1;
    return i < 0 ? esc(text) : esc(text.slice(0, i)) + '<mark>' + esc(q) + '</mark>' + esc(text.slice(i + q.length));
  }

  /* =====================================================================
   * NEW PAYMENT
   * ===================================================================== */
  const form = $('#payForm');
  const F = {};
  FIELDS.forEach(k => { F[k] = $('#f_' + k); });
  F.date = $('#f_date');

  const normVehicle = v => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14);
  const normId = v => v.toUpperCase().replace(/\s+/g, '').slice(0, 24);
  const normMobile = v => {
    let d = v.replace(/\D/g, '');
    if (d.length > 10 && /^(91|0)/.test(d)) d = d.replace(/^(91|0)/, '');
    return d.slice(0, 10);
  };
  const normAmount = v => {
    v = v.replace(/[^\d.]/g, '');
    const i = v.indexOf('.');
    if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '').slice(0, 2);
    return v.replace(/^0+(?=\d)/, '').slice(0, 12);
  };
  /** Re-formats an input while typing and keeps the cursor in place. */
  function normalize(el, fn) {
    const v = el.value;
    const nv = fn(v);
    if (nv === v) return;
    const pos = el.selectionStart == null ? v.length : el.selectionStart;
    const caret = fn(v.slice(0, pos)).length;
    el.value = nv;
    try { el.setSelectionRange(caret, caret); } catch (e) { /* not supported for this input type */ }
  }

  function readForm() {
    return {
      vehicle: normVehicle(F.vehicle.value),
      driverId: normId(F.driverId.value),
      name: F.name.value.trim().replace(/\s+/g, ' '),
      mobile: F.mobile.value.replace(/\D/g, ''),
      amount: Math.round((parseFloat(F.amount.value) || 0) * 100) / 100,
      date: F.date.value || today(),
      remark: F.remark.value.trim(),
      by: F.by.value.trim().replace(/\s+/g, ' ')
    };
  }

  function setErr(k, msg) {
    const field = k === 'photo' ? $('#photoField') : F[k].closest('.field');
    field.classList.toggle('bad', !!msg);
    const e = $('#e_' + k);
    if (e) e.textContent = msg || '';
  }

  /* ----- vehicle no. → today's driver from the Attendance sheet ----- */
  const vehNote = $('#vehNote');
  const pendBox = $('#pendBox');
  /** Red flag under the plate when the entered vehicle OR driver has a pending parchi ("Parchi pending" sheet). */
  function renderPending() {
    const list = pendingFor(normVehicle(F.vehicle.value));
    pendingForDriver(F.driverId.value).forEach(p => { if (list.indexOf(p) < 0) list.push(p); });
    if (!list.length) { pendBox.hidden = true; pendBox.innerHTML = ''; return; }
    pendBox.innerHTML = pendingHtml(list);
    pendBox.hidden = false;
  }
  let vehTimer = null;
  function setVehNote(kind, text) {
    vehNote.className = 'vnote ' + (kind || '');
    vehNote.innerHTML = text || '';
    vehNote.hidden = !text;
  }
  /** Fills Driver ID / Name / Mobile — never over something the user typed by hand. */
  function fillDriver(d) {
    if (F.driverId.value.trim() && !F.driverId.dataset.auto) return false;
    F.driverId.value = d.driverId || d.id || '';
    F.name.value = d.name || '';
    F.mobile.value = d.mobile || '';
    ['driverId', 'name', 'mobile'].forEach(k => { F[k].dataset.auto = '1'; setErr(k, ''); });
    return true;
  }
  /** Removes a driver that came from the vehicle lookup (a hand-typed Driver ID stays). */
  function clearAutoDriver() {
    if (!F.driverId.dataset.auto) return;
    ['driverId', 'name', 'mobile'].forEach(k => { if (F[k].dataset.auto) { F[k].value = ''; delete F[k].dataset.auto; } });
  }
  /**
   * A typed vehicle → { v: full number, d: today's driver or null }, or null.
   * Exact number first; when the user has left the box, also the end of a number
   * ("BJ3811" → "CG08BJ3811") — but only when exactly one known vehicle ends like that
   * (vehicle list from the Calling Sheet + today's attendance).
   */
  function attFor(v, final) {
    const att = S.att || {};
    if (att[v]) return { v: v, d: att[v] };
    if (!final || v.length < 4) return null;
    const seen = {};
    const ends = vehicleList().concat(Object.keys(att))
      .filter(k => !seen[k] && (seen[k] = 1) && k.length > v.length && k.slice(-v.length) === v);
    return ends.length === 1 ? { v: ends[0], d: att[ends[0]] || null } : null;
  }
  /** final = the user has left the box (show "not found"); otherwise stay quiet while typing. */
  async function lookupVehicle(final) {
    const v = normVehicle(F.vehicle.value);
    renderPending(); // instant: the list is already on this device
    if (v.length < 4) { setVehNote(''); clearAutoDriver(); renderPending(); loadTrips(''); return; }
    // today's list is still on its way → wait for it instead of asking the server per keystroke
    // (the attendance request only starts once the start-up data is in, so check them one after the other)
    for (const pending of [() => bootPromise, () => attPromise]) {
      if (S.attDate === today() || !pending()) continue;
      if (final) setVehNote('wait', 'Loading today’s attendance…');
      await pending();
      if (normVehicle(F.vehicle.value) !== v) return;
    }
    // page left open since yesterday → get today's list first
    if (!DEMO && final && S.attDate !== today() && Date.now() - (S.attFetched || 0) > 180000) {
      setVehNote('wait', 'Loading today’s attendance…');
      S.attFetched = Date.now();
      await loadAttendance();
      if (normVehicle(F.vehicle.value) !== v) return;
    }
    let d = null;
    if (S.attDate === today()) {
      let hit = attFor(v, final);
      // not in the list on this device → the sheet may have been filled after it was loaded:
      // fetch the latest attendance once (at most every 3 minutes) and look again
      if (!hit && final && !DEMO && Date.now() - (S.attFetched || 0) > 180000) {
        setVehNote('wait', 'Checking latest attendance…');
        S.attFetched = Date.now();
        await loadAttendance();
        if (normVehicle(F.vehicle.value) !== v) return; // the number changed meanwhile (or was completed)
        hit = attFor(v, final);
      }
      if (hit && hit.v !== v) {
        // "BJ3811" → the full number from the attendance sheet, "CG08BJ3811"
        F.vehicle.value = hit.v;
        return lookupVehicle(final);
      }
      d = hit ? hit.d : null;
    } else if (!DEMO && final) {
      setVehNote('wait', 'Checking today’s attendance…');
      try {
        const r = await api('vehicleDriver', { vehicle: v });
        if (normVehicle(F.vehicle.value) !== v) return; // the number changed meanwhile
        d = r.found ? r : null;
        if (!d && r.note) S.attNote = r.note;
      } catch (e) {
        if (e.code === 'AUTH') showPin(() => lookupVehicle(final));
        setVehNote('');
        return;
      }
    }
    if (d) {
      if (fillDriver(d)) setVehNote('ok', '✓ Today’s driver (Attendance): <b>' + esc(d.name || d.driverId || d.id) + '</b>');
      else setVehNote('', '');
    } else {
      clearAutoDriver();
      if (final) setVehNote('none', S.attNote
        ? 'Could not read today’s attendance — please fill the driver details.'
        : 'No driver for this vehicle in today’s attendance — please fill the driver details.');
      else setVehNote('');
    }
    renderPending(); // the driver may have changed with the vehicle
    // a complete number (known today, or the user left the box) → show its trips
    if (d || final) loadTrips(v);
  }

  /* ----- vehicle no. → its trips from the Dispatch sheet (latest first) ----- */
  const tripBox = $('#tripBox');
  const tripCache = {};
  let tripFor = '';
  // only one trip open at a time: opening one closes the others
  // ("toggle" does not bubble, so listen in the capture phase)
  tripBox.addEventListener('toggle', e => {
    if (!e.target.open) return;
    $$('details.trip[open]', tripBox).forEach(d => { if (d !== e.target) d.open = false; });
  }, true);
  async function loadTrips(v) {
    if (!v || DEMO) { tripFor = ''; tripBox.hidden = true; tripBox.innerHTML = ''; return; }
    if (v === tripFor) return;
    tripFor = v;
    if (tripCache[v]) { renderTrips(tripCache[v]); return; }
    tripBox.hidden = false;
    tripBox.innerHTML = tripsHead(v, 0) + '<p class="trips-note">Loading trips…</p>';
    try {
      const r = await api('vehicleTrips', { vehicle: v });
      tripCache[v] = r;
      if (tripFor === v) renderTrips(r);
    } catch (e) {
      if (tripFor !== v) return;
      tripFor = '';
      if (e.code === 'AUTH') { tripBox.hidden = true; return; }
      tripBox.innerHTML = tripsHead(v, 0) + '<p class="trips-note">Could not load trips: ' + esc(e.message) + '</p>';
    }
  }
  function tripsHead(v, total) {
    return '<div class="trips-h">' + icon('route') + 'Trips · <span class="vno">' + esc(v) + '</span>' + (total ? ' (' + total + ')' : '') + '</div>';
  }
  /** Every filled column of the trip row is shown, so new sheet columns appear by themselves. */
  function renderTrips(r) {
    tripBox.hidden = false;
    const H = r.headers || [];
    if (!r.trips || !r.trips.length) {
      tripBox.innerHTML = tripsHead(r.vehicle, 0) + '<p class="trips-note">' +
        esc(r.note || 'No trips for this vehicle in the Dispatch sheet.') + '</p>';
      return;
    }
    const at = re => H.findIndex(h => re.test(h));
    const iFrom = at(/^from/i), iTo = at(/^to\b/i), iItem = at(/^item/i);
    const iSD = at(/start date/i), iST = at(/start time/i), iED = at(/end date/i), iET = at(/end time/i);
    // S No / Vehicle No are known; Trip Name only repeats From → To + Item
    const skip = h => /^(s\.?\s*no\.?|vehicle no\.?)$/i.test(h) || /^trip name/i.test(h);
    const label = h => h.replace(/\(auto\)/ig, '').replace(/\s+/g, ' ').trim();
    const cell = (t, i) => (i >= 0 ? String(t[i] || '').trim() : '');
    tripBox.innerHTML = tripsHead(r.vehicle, r.total) + r.trips.map((t, n) => {
      const running = iED >= 0 && !cell(t, iED);
      const route = [cell(t, iFrom), cell(t, iTo)].filter(Boolean).join(' → ') || 'Trip';
      const when = running
        ? 'Started ' + [cell(t, iSD), cell(t, iST)].filter(Boolean).join(' ')
        : 'Ended ' + [cell(t, iED), cell(t, iET)].filter(Boolean).join(' ');
      const rows = H.map((h, i) => (skip(h) || i === iFrom || i === iTo || !cell(t, i)) ? ''
        : '<dt>' + esc(label(h)) + '</dt><dd>' + esc(cell(t, i)) + '</dd>').join('');
      return '<details class="trip"' + (n === 0 ? ' open' : '') + '><summary>' +
        '<span class="trip-st ' + (running ? 'run' : 'done') + '">' + (running ? 'Running' : 'Completed') + '</span>' +
        '<b>' + esc(route) + '</b><small>' + esc([cell(t, iItem), when].filter(Boolean).join(' · ')) + '</small>' +
        '</summary><dl>' + rows + '</dl></details>';
    }).join('') +
    (r.total > r.trips.length ? '<p class="trips-note">Latest ' + r.trips.length + ' of ' + r.total + ' trips</p>' : '');
  }
  F.vehicle.addEventListener('input', () => {
    normalize(F.vehicle, normVehicle);
    clearTimeout(vehTimer);
    vehTimer = setTimeout(() => lookupVehicle(false), 150);
  });
  F.vehicle.addEventListener('change', () => { clearTimeout(vehTimer); lookupVehicle(true); });

  // suggestions: "AW" → every vehicle with AW, "AW32" → CG08AW3211 (list = Calling Sheet column C)
  function findVehicles(text) {
    const q = normVehicle(text);
    if (q.length < 2) return [];
    return vehicleList().filter(v => v.indexOf(q) >= 0 && v !== q)
      .sort((a, b) => (a.indexOf(q) === 0 ? 0 : 1) - (b.indexOf(q) === 0 ? 0 : 1) || a.localeCompare(b))
      .slice(0, 8);
  }
  suggestBox(F.vehicle, findVehicles,
    (v, typed) => {
      const d = (S.att || {})[v];
      return '<span class="vno">' + mark(v, normVehicle(typed)) + '</span>' +
        '<small>' + (d ? esc(d.name || d.id) + ' · ' + esc(d.id) : (S.fleet ? 'no driver in today’s attendance' : 'paid before')) + '</small>' +
        (pendingFor(v).length ? '<span class="flag">' + icon('flag') + 'Parchi pending</span>' : '');
    },
    async v => {
      F.vehicle.value = v;
      setErr('vehicle', '');
      clearTimeout(vehTimer);
      await lookupVehicle(true);
      (F.driverId.value ? (F.mobile.value ? F.amount : F.mobile) : F.driverId).focus();
    });

  F.mobile.addEventListener('input', () => { normalize(F.mobile, normMobile); delete F.mobile.dataset.auto; });
  F.amount.addEventListener('input', () => normalize(F.amount, normAmount));
  F.name.addEventListener('input', () => { delete F.name.dataset.auto; });
  // typing a Driver ID by hand: a known driver's name + mobile fill in by themselves
  F.driverId.addEventListener('input', () => {
    delete F.driverId.dataset.auto;
    normalize(F.driverId, normId);
    const d = S.drivers[normId(F.driverId.value)];
    if (d) {
      if (!F.name.value.trim() || F.name.dataset.auto) { F.name.value = d.name || ''; F.name.dataset.auto = '1'; setErr('name', ''); }
      if (d.mobile && (!F.mobile.value.trim() || F.mobile.dataset.auto)) { F.mobile.value = d.mobile; F.mobile.dataset.auto = '1'; setErr('mobile', ''); }
    } else {
      if (F.name.dataset.auto) { F.name.value = ''; delete F.name.dataset.auto; }
      if (F.mobile.dataset.auto) { F.mobile.value = ''; delete F.mobile.dataset.auto; }
    }
    renderPending(); // a typed Driver ID also shows its pending parchi
  });

  FIELDS.forEach(k => F[k].addEventListener('input', () => {
    if (k !== 'remark') setErr(k, '');
  }));

  /* ----- payment date: today by default, an earlier day = back date ----- */
  function setPayDate(d) {
    F.date.max = today();
    F.date.value = d || today();
    showPayDate();
  }
  function showPayDate() {
    const d = F.date.value, t = today();
    const back = /^\d{4}-\d{2}-\d{2}$/.test(d) && d < t;
    const days = back ? Math.round((Date.parse(t) - Date.parse(d)) / 86400000) : 0;
    $('#vDate').textContent = fmtDate(d || t);
    $('#vDate').classList.toggle('back', back);
    const note = $('#backNote');
    note.hidden = !back;
    note.textContent = back ? '⏪ Back date · ' + fmtDate(d) + ' · ' + (days === 1 ? 'yesterday' : days + ' days ago') : '';
    $$('.pdate-q [data-days]').forEach(b => b.classList.toggle('on', !!d && Number(b.dataset.days) === days && (back || d === t)));
    setErr('date', '');
  }
  F.date.addEventListener('input', showPayDate);
  F.date.addEventListener('change', showPayDate);
  // a new day may have started while the page was open
  F.date.addEventListener('focus', () => { F.date.max = today(); });
  // the whole box opens the calendar (not only the small icon)
  F.date.addEventListener('click', () => { try { if (F.date.showPicker) F.date.showPicker(); } catch (e) { /* not allowed here */ } });
  $('#dateField').addEventListener('click', e => {
    const b = e.target.closest('[data-days]');
    if (!b) return;
    const x = new Date();
    x.setDate(x.getDate() - Number(b.dataset.days));
    setPayDate(ymd(x));
  });

  // Enter = next field (phones show "Next"), not submit half a form
  form.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.isComposing) return;
    if (e.defaultPrevented) return; // Enter picked a suggestion
    e.preventDefault();
    const order = FIELDS.map(k => F[k]);
    const i = order.indexOf(e.target);
    if (i >= 0 && i < order.length - 1) order[i + 1].focus();
    else e.target.blur();
  });

  /* ----- receipt photo ----- */
  const fileInput = $('#f_photo');
  const uploadBox = $('#uploadBox');
  const preview = $('#photoPreview');

  function pickPhoto() {
    fileInput.value = '';
    fileInput.click();
  }
  uploadBox.addEventListener('click', pickPhoto);
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  // computers: drag & drop a file on the box
  ['dragenter', 'dragover'].forEach(t => uploadBox.addEventListener(t, e => e.preventDefault()));
  uploadBox.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  async function handleFile(file) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    const isImg = /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.name || '');
    if (!isPdf && !isImg) { toast('Please choose a photo or a PDF', true); return; }
    clearPhoto();
    S.photoBusy = true;
    setErr('photo', '');
    uploadBox.hidden = true;
    preview.hidden = false;
    preview.innerHTML = '<div class="loading"><div class="spin sm"></div>Preparing photo…</div>';
    try {
      if (isPdf) {
        if (file.size > MAX_MB * 1048576) throw new Error('File is too big (max ' + MAX_MB + ' MB)');
        S.photo = { data: await blobToBase64(file), type: 'application/pdf', name: file.name || 'receipt.pdf', pdf: true };
      } else {
        let out = null;
        try { out = await compressImage(file); } catch (e) { out = null; }
        if (out && out.blob) {
          S.photo = { data: await blobToBase64(out.blob), type: 'image/jpeg', name: file.name || 'receipt.jpg', url: URL.createObjectURL(out.blob), thumb: out.thumb };
        } else {
          // the browser cannot read this image (e.g. HEIC on a computer) — send it as it is
          if (file.size > MAX_MB * 1048576) throw new Error('Photo is too big (max ' + MAX_MB + ' MB)');
          S.photo = { data: await blobToBase64(file), type: file.type || 'image/jpeg', name: file.name || 'receipt' };
        }
      }
      renderPhoto();
      startStage(S.photo);
    } catch (e) {
      clearPhoto();
      toast(e.message || 'Could not read this file — try another photo', true);
    } finally {
      S.photoBusy = false;
    }
  }

  /**
   * Fast submit: the receipt goes up to Google Drive in the background as soon as it is chosen,
   * while the rest of the form is being filled. Submit then sends only the text (a few hundred bytes).
   * photo.stage → the uploaded file's id, or null if that did not work (then Submit sends the photo itself).
   */
  function startStage(photo) {
    if (DEMO || !photo) return;
    const replace = S.oldStage || ''; // the photo chosen before this one (never submitted) is thrown away
    S.oldStage = '';
    photo.stage = api('stage', {
      file: { name: photo.name, type: photo.type, data: photo.data },
      replace: replace
    }, { timeout: 90000 })
      .then(r => (photo.stageId = r.stageId || null))
      .catch(() => null);
  }

  function renderPhoto() {
    const p = S.photo;
    if (!p) { preview.hidden = true; preview.innerHTML = ''; uploadBox.hidden = false; return; }
    uploadBox.hidden = true;
    preview.hidden = false;
    // the receipt looks taped onto the voucher
    preview.innerHTML =
      '<div class="photo"><span class="tape l"></span><span class="tape r"></span>' +
      (p.url ? '<img src="' + p.url + '" alt="Receipt photo">' : '<div class="pdf">' + icon('file') + esc(p.name) + '</div>') +
      '<span class="ok">✓ receipt attached</span></div>' +
      '<div class="acts"><button type="button" class="btn btn-light btn-sm" id="phChange">Change</button>' +
      '<button type="button" class="btn btn-light btn-sm" id="phRemove">Remove</button></div>';
  }
  preview.addEventListener('click', e => {
    if (e.target.closest('#phRemove')) clearPhoto();
    else if (e.target.closest('#phChange')) pickPhoto();
  });

  function clearPhoto() {
    if (S.photo && S.photo.url) URL.revokeObjectURL(S.photo.url);
    if (S.photo && S.photo.stageId && !S.photo.used) S.oldStage = S.photo.stageId;
    S.photo = null;
    renderPhoto();
  }

  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Cannot read image')); };
      img.src = url;
    });
  }
  /** Phone photo → JPEG of max PHOTO_MAX px (a 4 MB photo becomes ~250 KB, so upload is quick). */
  async function compressImage(file) {
    let img = await loadImage(file);
    const scale = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    let src = img, bmp = null;
    if (window.createImageBitmap) {
      try {
        bmp = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        src = bmp;
      } catch (e) { bmp = null; }
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    if (bmp) bmp.close();
    img.src = '';
    img = src = bmp = null;
    const t = document.createElement('canvas');
    const ts = Math.min(1, 360 / Math.max(w, h));
    t.width = Math.max(1, Math.round(w * ts));
    t.height = Math.max(1, Math.round(h * ts));
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    const thumb = t.toDataURL('image/jpeg', 0.7);
    const blob = await canvasJpeg(c, PHOTO_Q);
    c.width = c.height = t.width = t.height = 0;
    return { blob: blob, thumb: thumb };
  }
  /** Some phones never call back toBlob() now and then — fall back to toDataURL after 6 s. */
  function canvasJpeg(c, q) {
    return new Promise(res => {
      let done = false;
      const finish = b => { if (!done) { done = true; res(b); } };
      const timer = setTimeout(() => {
        try {
          const bin = atob(c.toDataURL('image/jpeg', q).split(',')[1]);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          finish(new Blob([arr], { type: 'image/jpeg' }));
        } catch (e) { finish(null); }
      }, 6000);
      try { c.toBlob(b => { clearTimeout(timer); finish(b); }, 'image/jpeg', q); } catch (e) { /* timer handles it */ }
    });
  }
  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = () => rej(new Error('Cannot read file'));
      r.readAsDataURL(blob);
    });
  }

  /* ----- submit ----- */
  function validate(v) {
    const errs = {};
    // Vehicle No is optional; one that is typed must be complete
    if (v.vehicle && v.vehicle.length < 4) errs.vehicle = 'Vehicle number looks incomplete (or leave it empty)';
    if (v.name.length < 2) errs.name = 'Enter the driver name';
    // Driver ID and Mobile are optional; a mobile that is filled in must be complete
    if (v.mobile && !/^\d{10}$/.test(v.mobile)) errs.mobile = 'Mobile number must be 10 digits (or leave it empty)';
    if (!(v.amount > 0)) errs.amount = 'Enter the amount';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || v.date < '2020-01-01') errs.date = 'Choose the payment date';
    else if (v.date > today()) errs.date = 'Payment date cannot be in the future';
    if (!S.photo) errs.photo = 'Upload the receipt photo';
    if (!v.by) errs.by = 'Enter your name';
    const keys = ['vehicle', 'driverId', 'name', 'mobile', 'amount', 'date', 'photo', 'by'];
    keys.forEach(k => setErr(k, errs[k] || ''));
    const first = keys.find(k => errs[k]);
    if (!first) return true;
    const el = first === 'photo' ? uploadBox : F[first];
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (first !== 'photo') setTimeout(() => el.focus({ preventScroll: true }), 300);
    return false;
  }

  form.addEventListener('submit', e => { e.preventDefault(); submit(); });

  function showSaving(on, sub) {
    const ov = $('#savingOv');
    if (sub) $('#savingSub').textContent = sub;
    if (on) { ov.hidden = false; fadeIn(ov); } else fadeOut(ov);
  }
  const UPLOADING = 'Uploading receipt to Google Drive';

  async function submit() {
    if (S.busy) return;
    if (S.photoBusy) { toast('Photo is still being prepared — one moment'); return; }
    const v = readForm();
    if (!validate(v)) return;
    S.clientId = S.clientId || uid(); // same id on "Try again", so the server never saves it twice
    S.busy = true;
    $('#submitBtn').disabled = true;
    const photo = S.photo;
    showSaving(true, photo.stageId ? 'Receipt already uploaded ✓ — saving entry' : UPLOADING);
    try {
      // the photo is normally already in Drive by now (uploaded while the form was filled)
      const stageId = photo.stage ? await photo.stage : null;
      if (stageId) $('#savingSub').textContent = 'Receipt already uploaded ✓ — saving entry';
      const send = sid => api('submit', Object.assign({
        clientId: S.clientId,
        data: v,
        thumb: DEMO ? photo.thumb : undefined
      }, sid ? { stageId: sid } : { file: { name: photo.name, type: photo.type, data: photo.data } }));
      let r;
      try {
        r = await send(stageId);
      } catch (err) {
        if (!stageId || err.code !== 'STAGE') throw err;
        // the early upload was lost (e.g. form left open for hours) → send the photo with the entry
        photo.stage = null;
        photo.stageId = null;
        $('#savingSub').textContent = UPLOADING;
        r = await send(null);
      }
      photo.used = true;
      showSaving(false);
      onSaved(r.row);
    } catch (err) {
      showSaving(false);
      if (err.code === 'AUTH') { showPin(submit); return; }
      $('#errMsg').textContent = err.message;
      openPopup($('#errOv'));
    } finally {
      S.busy = false;
      $('#submitBtn').disabled = false;
    }
  }
  $('#retryBtn').addEventListener('click', () => { closePopup(); setTimeout(submit, 250); });

  function onSaved(row) {
    // keep the lists on this device up to date without asking the server again
    S.recent.unshift(row);
    S.recent = S.recent.slice(0, 30);
    S.period = null; // the period list is fetched again next time (the new payment may belong to it)
    S.vehicles = S.vehicles || [];
    if (row.vehicle && S.vehicles.indexOf(row.vehicle) < 0) S.vehicles.unshift(row.vehicle);
    let d = row.driverId ? S.drivers[row.driverId] : { count: 0, total: 0 }; // no ID → nothing to remember
    if (!d) { d = S.drivers[row.driverId] = { id: row.driverId, count: 0, total: 0 }; S.list.unshift(d); }
    d.name = row.name;
    d.mobile = row.mobile;
    d.count = (d.count || 0) + 1;
    d.total = (d.total || 0) + row.amount;
    saveBoot();
    if (!S.hist) renderRecent();
    else if (S.hist.selected === row.driverId) runHistory(S.hist.opts, true);

    // clear the form for the next entry (keep "Uploaded By")
    const by = F.by.value;
    form.reset();
    F.by.value = by;
    setPayDate(); // the next entry starts on today again (a back date is never carried over by mistake)
    delete F.driverId.dataset.auto;
    delete F.name.dataset.auto;
    delete F.mobile.dataset.auto;
    setVehNote('');
    loadTrips('');
    renderPending();
    clearPhoto();
    S.clientId = null;

    // the saved voucher gets a red PAID stamp
    $('#okBody').innerHTML =
      '<span class="stamp">Paid</span>' +
      '<h3>Cash Pay Advice</h3>' +
      '<div class="no">No. ' + esc(row.adviceNo) + '</div>' +
      '<div class="amount">' + inr(row.amount) + '</div>' +
      '<dl>' +
        '<dt>Driver</dt><dd>' + esc(row.name) + (row.driverId ? ' · ' + esc(row.driverId) : '') + '</dd>' +
        (row.vehicle ? '<dt>Vehicle</dt><dd><span class="vno">' + esc(row.vehicle) + '</span></dd>' : '') +
        '<dt>Date</dt><dd>' + esc(fmtDate(row.date)) + (row.date && row.date < today() ? '<span class="bk">Back date</span>' : '') + '</dd>' +
        '<dt>Paid by</dt><dd>' + esc(row.by) + '</dd>' +
      '</dl>' +
      // where the receipt photo went in Google Drive (and why, if not the chosen folder)
      (row.savedIn ? '<p class="slip-drive' + (row.driveNote ? ' warn' : '') + '">' +
        (row.driveNote ? '⚠ ' + esc(row.driveNote) + '<br>' : '') +
        'Receipt saved in Drive: <b>' + esc(row.savedIn) + '</b></p>' : '') +
      '<button type="button" class="press" data-close>OK · Next Entry</button>';
    openPopup($('#okOv'));
  }

  /* =====================================================================
   * PAYMENT HISTORY
   * ===================================================================== */
  const qIn = $('#q');
  const histBody = $('#histBody');

  /* ----- driver suggestions under the search box ----- */
  function findDrivers(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const qk = q.replace(/[^a-z0-9]/g, '');
    return S.list
      // only drivers who were paid (the attendance list also holds unpaid drivers)
      .filter(d => d.count > 0)
      .filter(d => d.id.toLowerCase().indexOf(qk || q) >= 0 || (d.name || '').toLowerCase().indexOf(q) >= 0 ||
        (/^\d{4,}$/.test(qk) && (d.mobile || '').indexOf(qk) >= 0))
      .sort((a, b) => (a.id.toLowerCase().indexOf(qk) === 0 ? 0 : 1) - (b.id.toLowerCase().indexOf(qk) === 0 ? 0 : 1))
      .slice(0, 8);
  }
  const driverSugg = suggestBox(qIn, findDrivers,
    d => '<b>' + esc(d.name) + '</b> · ' + esc(d.id) + '<small>' + (d.mobile ? esc(d.mobile) : '') + '</small>',
    d => {
      qIn.value = d.id;
      qIn.blur();
      runHistory({ driverId: d.id });
    });
  qIn.addEventListener('input', () => { $('#qClear').hidden = !qIn.value; });

  $('#qClear').addEventListener('click', () => {
    qIn.value = '';
    $('#qClear').hidden = true;
    S.hist = null;
    renderRecent();
    qIn.focus();
  });
  $('#searchForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = qIn.value.trim();
    driverSugg.close();
    qIn.blur();
    if (!q) { S.hist = null; renderRecent(); return; }
    const id = normId(q);
    runHistory(S.drivers[id] ? { driverId: id } : { q: q });
  });

  function thumbBtn(r, i) {
    const src = imgUrl(r, 200);
    return '<button type="button" class="thumb" data-img="' + i + '" aria-label="View receipt">' + icon('file') +
      (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + '</button>';
  }

  /** Date in the ledger's red margin: big day, small month. */
  function marginDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return '<div class="l-date">' + (m ? '<b>' + (+m[3]) + '</b><small>' + MONTHS[+m[2] - 1] + ' ' + m[1].slice(2) + '</small>' : '') + '</div>';
  }
  /** A ruled ledger; xls = show the "Excel" download button in its header. */
  const ledger = (title, body, xls) => '<div class="ledger"><div class="ledger-h"><span>' + title + '</span>' +
    (xls ? '<button type="button" class="xls" data-act="xls">' + icon('download') + 'Excel</button>' : '') + '</div>' + body + '</div>';

  /* ----- period (From – To) ----- */
  const rFrom = $('#rFrom');
  const rTo = $('#rTo');
  S.range = { from: '', to: '' };
  S.period = null; // { key, rows, total } — every payment in the period (when no driver is searched)
  const rangeSet = () => !!(S.range.from || S.range.to);
  const inRange = r => (!S.range.from || r.date >= S.range.from) && (!S.range.to || r.date <= S.range.to);
  function rangeLabel() {
    const f = S.range.from, t = S.range.to;
    if (f && t) return f === t ? fmtDate(f) : fmtDate(f) + ' – ' + fmtDate(t);
    return f ? 'from ' + fmtDate(f) : t ? 'till ' + fmtDate(t) : '';
  }
  function onRange() {
    let f = rFrom.value, t = rTo.value;
    if (f && t && f > t) { const x = f; f = t; t = x; rFrom.value = f; rTo.value = t; }
    S.range = { from: f, to: t };
    $('#rClear').hidden = !rangeSet();
    if (S.hist) renderHistory(); else renderRecent();
  }
  rFrom.addEventListener('change', onRange);
  rTo.addEventListener('change', onRange);
  $('#rClear').addEventListener('click', () => { rFrom.value = ''; rTo.value = ''; onRange(); });

  /** Every payment in the chosen period (all drivers). */
  async function loadPeriod() {
    const key = S.range.from + '|' + S.range.to;
    S.period = { key: key, rows: null, total: 0 };
    histBody.innerHTML = ledger('Payments · ' + esc(rangeLabel()), loadingNote());
    try {
      const r = await api('history', { from: S.range.from, to: S.range.to });
      if (!S.period || S.period.key !== key) return;
      S.period.rows = r.rows || [];
      S.period.total = r.total || S.period.rows.length;
      if (!S.hist) renderPeriod();
    } catch (e) {
      if (!S.period || S.period.key !== key) return;
      S.period = null;
      if (e.code === 'AUTH') { showPin(() => renderRecent()); return; }
      if (!S.hist) histBody.innerHTML = ledger('Payments · ' + esc(rangeLabel()), emptyNote('Could not load', esc(e.message) +
        '<br><br><button class="btn btn-light btn-sm" data-act="period">Try again</button>'));
    }
  }
  function renderPeriod() {
    const rows = S.period.rows;
    S.viewRows = rows;
    S.export = { rows: rows, title: 'All payments · ' + rangeLabel(), file: 'CashPay_' + (S.range.from || 'start') + '_to_' + (S.range.to || today()) };
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const body = !rows.length
      ? emptyNote('No payments in this period', 'Choose other dates, or clear them to see the latest payments.')
      : '<div class="ledger-sum"><b>' + rows.length + '</b> ' + (rows.length === 1 ? 'payment' : 'payments') + ' · Total <b>' + inr(total) + '</b>' +
        (S.period.total > rows.length ? ' · showing the latest ' + rows.length + ' of ' + S.period.total : '') + '</div>' +
        rows.map(listRow).join('');
    histBody.innerHTML = ledger('Payments · ' + esc(rangeLabel()), body, rows.length > 0);
  }
  /** One payment in the Recent / period lists (tap → that driver's history). */
  function listRow(r) {
    return '<div class="lrow click" data-driver="' + esc(r.driverId) + '" data-name="' + esc(r.name) + '">' + marginDate(r.date) +
      '<div class="l-main"><b>' + esc(r.name) + '</b><small>' + vnoTag(r.vehicle) + esc(r.driverId) + '</small></div>' +
      '<div class="l-amt">' + inr(r.amount) + '</div>' + icon('chev') + '</div>';
  }
  const emptyNote = (title, text) => '<div class="empty"><b>' + title + '</b>' + text + '</div>';
  const loadingNote = () => '<div class="loading"><div class="loader" style="width:120px;margin:0"><svg class="truck"><use href="#truck"/></svg></div></div>';

  function renderRecent() {
    if (S.hist) return;
    // dates chosen → every payment in that period instead of the latest ones
    if (rangeSet()) {
      const key = S.range.from + '|' + S.range.to;
      if (!S.period || S.period.key !== key) loadPeriod();
      else if (S.period.rows) renderPeriod();
      return;
    }
    S.viewRows = S.recent;
    S.export = { rows: S.recent, title: 'Latest payments', file: 'CashPay_latest_' + today() };
    let body;
    if (!S.booted && S.bootError) {
      body = emptyNote('Could not load', esc(S.bootError) + '<br><br><button class="btn btn-light btn-sm" data-act="reload">Try again</button>');
    } else if (!S.booted) {
      body = loadingNote();
    } else if (!S.recent.length) {
      body = emptyNote('No payments yet', 'Every cash payment you submit is written here.');
    } else {
      body = S.recent.map(listRow).join('');
    }
    histBody.innerHTML = ledger('Recent Payments', body, S.recent.length > 0);
  }

  /** keepTab = refresh in the background (after a new payment) without switching tabs. */
  async function runHistory(opts, keepTab) {
    if (!keepTab) setView('history');
    qIn.value = opts.driverId || opts.q;
    $('#qClear').hidden = false;
    const key = JSON.stringify(opts);
    S.hist = { key: key, opts: opts, rows: null, selected: opts.driverId || null };
    histBody.innerHTML = ledger('Searching…', loadingNote());
    try {
      const r = await api('history', opts);
      if (!S.hist || S.hist.key !== key) return; // a newer search has started
      S.hist.rows = r.rows || [];
      renderHistory();
    } catch (e) {
      if (!S.hist || S.hist.key !== key) return;
      if (e.code === 'AUTH') { showPin(() => runHistory(opts)); return; }
      histBody.innerHTML = ledger('Payment History', emptyNote('Could not load', esc(e.message) +
        '<br><br><button class="btn btn-light btn-sm" data-act="retry">Try again</button>'));
    }
  }

  function renderHistory() {
    const H = S.hist;
    if (!H.rows) return; // still loading
    // the chosen period (if any) applies to the search results too
    const rows = H.rows.filter(inRange);
    if (!rows.length) {
      histBody.innerHTML = ledger('Payment History', rangeSet() && H.rows.length
        ? emptyNote('No payments in this period', 'This driver has payments on other dates — change or clear the dates.')
        : emptyNote('No payments found', 'Check the driver ID or name and try again.'));
      return;
    }
    // one group per driver: by Driver ID, or by name for payments saved without an ID
    const groupOf = r => r.driverId || '~' + (r.name || '').toUpperCase();
    const groups = {};
    const order = [];
    rows.forEach(r => {
      const g = groupOf(r);
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(r);
    });
    if (!H.selected && order.length === 1) H.selected = order[0];

    // the name matches more than one driver → choose one
    if (!H.selected) {
      histBody.innerHTML = ledger(order.length + ' drivers found — choose one',
        order.map(id => {
          const g = groups[id];
          const total = g.reduce((s, r) => s + r.amount, 0);
          return '<div class="lrow click" data-pick="' + esc(id) + '"><div class="l-date"><span class="av" style="width:42px;height:42px;font-size:17px;margin:0 auto">' + esc(initials(g[0].name)) + '</span></div>' +
            '<div class="l-main"><b>' + esc(g[0].name) + '</b><small>' + (g[0].driverId ? esc(g[0].driverId) + ' · ' : '') + g.length + (g.length === 1 ? ' payment' : ' payments') + '</small></div>' +
            '<div class="l-amt">' + inr(total) + '</div>' + icon('chev') + '</div>';
        }).join(''));
      return;
    }

    const list = groups[H.selected] || [];
    S.viewRows = list;
    const d = list[0];
    const total = list.reduce((s, r) => s + r.amount, 0);
    S.export = { rows: list, title: d.name + (d.driverId ? ' (' + d.driverId + ')' : '') + (rangeSet() ? ' · ' + rangeLabel() : ' · all payments'),
      file: 'CashPay_' + (d.driverId || d.name) + (rangeSet() ? '_' + (S.range.from || 'start') + '_to_' + (S.range.to || today()) : '') };
    histBody.innerHTML =
      (order.length > 1 ? '<button class="back" data-act="unpick">← All ' + order.length + ' drivers</button>' : '') +
      // driving-licence style card
      '<div class="dcard">' +
        '<div class="dcard-top"><span>Driver</span><span>Daman Group</span></div>' +
        '<div class="dcard-body"><span class="av">' + esc(initials(d.name)) + '</span><div>' +
          '<h2>' + esc(d.name) + '</h2>' +
          (d.driverId ? '<p>ID <b>' + esc(d.driverId) + '</b></p>' : '') +
          (d.mobile ? '<p><a href="tel:+91' + esc(d.mobile) + '">' + icon('phone') + esc(d.mobile) + '</a></p>' : '') +
        '</div></div>' +
        '<div class="dcard-sum"><div><small>Total paid' + (rangeSet() ? ' · ' + esc(rangeLabel()) : '') + '</small><b>' + inr(total) + '</b></div>' +
          '<div><small>Payments</small><b>' + list.length + '</b></div></div>' +
      '</div>' +
      // red flag when this driver has a pending parchi ("Parchi pending" sheet)
      (function () {
        const pend = pendingForDriver(d.driverId);
        return pend.length ? '<div class="pending" role="alert">' + pendingHtml(pend) + '</div>' : '';
      })() +
      ledger('Payment History',
        list.map((r, i) =>
          '<div class="lrow">' + marginDate(r.date) +
          '<div class="l-main"><b>' + inr(r.amount) + '</b>' +
          '<small>' + vnoTag(r.vehicle) + esc(r.remark || '') + '</small>' +
          '<small>By ' + esc(r.by || '—') + ' · ' + esc(r.adviceNo) + '</small></div>' +
          thumbBtn(r, i) +
          '<button type="button" class="del" data-del="' + i + '" aria-label="Delete entry ' + esc(r.adviceNo) + '" title="Delete entry">' + icon('trash') + '</button>' +
          '</div>').join(''), true);
  }

  histBody.addEventListener('click', e => {
    const img = e.target.closest('[data-img]');
    if (img) { e.stopPropagation(); openReceipt(S.viewRows[+img.dataset.img]); return; }
    const del = e.target.closest('[data-del]');
    if (del) { openDelete(S.viewRows[+del.dataset.del]); return; }
    const pick = e.target.closest('[data-pick]');
    if (pick) { S.hist.selected = pick.dataset.pick; renderHistory(); window.scrollTo(0, 0); return; }
    const drv = e.target.closest('[data-driver]');
    if (drv) {
      runHistory(drv.dataset.driver ? { driverId: drv.dataset.driver } : { q: drv.dataset.name });
      window.scrollTo(0, 0);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'xls') exportExcel(act);
    else if (act.dataset.act === 'period') loadPeriod();
    else if (act.dataset.act === 'unpick') { S.hist.selected = null; renderHistory(); }
    else if (act.dataset.act === 'retry') runHistory(S.hist.opts);
    else if (act.dataset.act === 'reload') { S.bootError = ''; renderRecent(); loadBoot(); }
  });

  /* ----- Excel download of the list on screen ----- */
  let xlsxLib = null;
  /** SheetJS, loaded only when someone downloads. */
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxLib) {
      xlsxLib = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = () => (window.XLSX ? res(window.XLSX) : rej(new Error('Excel library missing')));
        s.onerror = () => { xlsxLib = null; rej(new Error('Excel library could not load')); };
        document.head.appendChild(s);
      });
    }
    return xlsxLib;
  }
  const ddmmyyyy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? m[3] + '-' + m[2] + '-' + m[1] : (s || ''); };
  async function exportExcel(btn) {
    const x = S.export;
    if (!x || !x.rows || !x.rows.length) { toast('Nothing to download', true); return; }
    const head = ['Advice No', 'Payment Date', 'Vehicle No', 'Driver ID', 'Driver Name', 'Mobile', 'Amount (Rs)', 'Remark', 'Uploaded By', 'Entered At', 'Receipt'];
    const body = x.rows.map(r => [r.adviceNo, ddmmyyyy(r.date), r.vehicle || '', r.driverId || '', r.name || '', r.mobile || '',
      Number(r.amount) || 0, r.remark || '', r.by || '', r.at || '', r.fileId ? driveView(r.fileId) : '']);
    const total = x.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const now = new Date();
    const aoa = [['Daman Group — Cash Pay Advices'], [x.title], ['Downloaded ' + fmtDate(today()) + ' ' + now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })], [], head]
      .concat(body, [[], ['', '', '', '', 'TOTAL · ' + x.rows.length + (x.rows.length === 1 ? ' payment' : ' payments'), '', total]]);
    const base = String(x.file || 'CashPay').replace(/[^\w\-]+/g, '_');
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
    try {
      const XLSX = await loadXlsx();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [11, 12, 13, 10, 24, 12, 12, 44, 18, 17, 46].map(w => ({ wch: w }));
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } }, { s: { r: 2, c: 0 }, e: { r: 2, c: 6 } }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payments');
      XLSX.writeFile(wb, base + '.xlsx');
      toast('Excel downloaded · ' + x.rows.length + (x.rows.length === 1 ? ' payment' : ' payments'));
    } catch (e) {
      // no internet for the library → a CSV file, which Excel opens as well
      const cell = v => {
        let s = String(v == null ? '' : v);
        if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s;
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const csv = '﻿' + aoa.map(r => r.map(cell).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = base + '.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('Downloaded as CSV (opens in Excel)');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  }

  /* ----- delete an entry (the server keeps a copy in the "Deleted" tab) ----- */
  let delRow = null;
  function openDelete(r) {
    if (!r) return;
    delRow = r;
    $('#delInfo').innerHTML = '<b>' + esc(r.adviceNo) + '</b> · ' + inr(r.amount) + '<br>' + esc(r.name) + ' · ' + esc(fmtDate(r.date));
    $('#delBy').value = F.by.value.trim() || session.get('cpa_del_by') || '';
    $('#delPw').value = '';
    $('#delPw').hidden = !S.delNeedsPw;
    $('#delErr').textContent = '';
    openPopup($('#delOv'));
    setTimeout(() => (!$('#delBy').value ? $('#delBy') : S.delNeedsPw ? $('#delPw') : $('#delBtn')).focus(), 80);
  }
  // The entry leaves the list at once; Google does the work in the background.
  // If Google says no (wrong password, no internet …) the entry comes back and the reason is shown.
  $('#delForm').addEventListener('submit', e => {
    e.preventDefault();
    const r = delRow;
    if (!r) return;
    const by = $('#delBy').value.trim();
    const password = $('#delPw').value;
    if (!by) { $('#delErr').textContent = 'Enter your name'; $('#delBy').focus(); return; }
    if (S.delNeedsPw && !password) { $('#delErr').textContent = 'Enter the delete password'; $('#delPw').focus(); return; }
    session.set('cpa_del_by', by);
    closePopup();
    const undo = removeLocal(r);
    toast('Deleting ' + r.adviceNo + '…');
    api('deleteEntry', { adviceNo: r.adviceNo, by: by, password: password }, { keepalive: true })
      .then(() => toast('Entry ' + r.adviceNo + ' deleted'))
      .catch(err => {
        if (/not found/i.test(err.message)) { toast('Entry ' + r.adviceNo + ' was already deleted'); return; }
        undo();
        if (err.code === 'AUTH') { showPin(); return; }
        toast(err.message, true);
        if (err.code === 'DELPW') {
          S.delNeedsPw = true;
          setTimeout(() => { openDelete(r); $('#delErr').textContent = err.message; }, 250);
        }
      });
  });
  /** Takes a deleted entry out of the lists on this device; returns a function that puts it back. */
  function removeLocal(r) {
    const same = x => x.adviceNo === r.adviceNo;
    const hist = S.hist;
    const period = S.period;
    const ri = S.recent.findIndex(same);
    const hi = hist && hist.rows ? hist.rows.findIndex(same) : -1;
    const pi = period && period.rows ? period.rows.findIndex(same) : -1;
    if (ri >= 0) S.recent.splice(ri, 1);
    if (hi >= 0) hist.rows.splice(hi, 1);
    if (pi >= 0) { period.rows.splice(pi, 1); period.total--; }
    const d = r.driverId && S.drivers[r.driverId];
    if (d) { d.count = Math.max(0, (d.count || 0) - 1); d.total = Math.max(0, (d.total || 0) - r.amount); }
    saveBoot();
    redraw();
    return function undo() {
      if (ri >= 0 && !S.recent.some(same)) S.recent.splice(ri, 0, r);
      if (hi >= 0 && S.hist === hist && !hist.rows.some(same)) hist.rows.splice(hi, 0, r);
      if (pi >= 0 && S.period === period && !period.rows.some(same)) { period.rows.splice(pi, 0, r); period.total++; }
      if (d) { d.count = (d.count || 0) + 1; d.total = (d.total || 0) + r.amount; }
      saveBoot();
      redraw();
    };
    function redraw() { if (S.hist && S.hist.rows) renderHistory(); else renderRecent(); }
  }

  /* ----- receipt viewer ----- */
  function openReceipt(r) {
    if (!r) return;
    const href = r.fileId ? driveView(r.fileId) : '';
    $('#lbTitle').textContent = inr(r.amount) + ' · ' + r.name + ' · ' + fmtDate(r.date);
    $('#lbOpen').hidden = !href;
    $('#lbOpen').href = href || '#';
    const wrap = $('#lbWrap');
    const src = imgUrl(r, 1600);
    wrap.innerHTML = '<img alt="Receipt" referrerpolicy="no-referrer">';
    const img = $('img', wrap);
    img.onerror = () => { wrap.innerHTML = '<p>Preview not available — tap “Open” to see the file.</p>'; };
    if (src) img.src = src; else img.onerror();
    openPopup($('#lightbox'));
  }

  /* ---------------- start ---------------- */
  function start() {
    // older versions kept the half-filled form; it is not remembered any more (user request)
    ['cpa_boot_v1', 'cpa_draft_v1', 'cpa_boot_v2', 'cpa_draft_v2', 'cpa_draft_v3'].forEach(k => store.del(k));
    session.del('cpa_picking');
    $$('[data-company]').forEach(el => { el.textContent = CFG.COMPANY || 'Daman Group'; });
    $$('[data-appname]').forEach(el => { el.textContent = CFG.APP_NAME || 'Cash Pay Advices'; });
    $('#demoBanner').hidden = !DEMO;
    rFrom.value = rTo.value = '';
    rFrom.max = rTo.max = today();
    // every refresh starts with an empty form (also when the browser tries to refill it)
    form.reset();
    setPayDate();
    setView(location.hash === '#history' ? 'history' : 'pay');

    const cached = store.get(K.boot);
    if (cached && cached.r && cached.demo === DEMO) applyBoot(cached.r);
    else renderRecent();

    // PIN needed and no valid login on this device → ask right away instead of after a server round trip
    if (!DEMO && S.needPin && !tokenAlive()) showPin();
    else loadBoot();

    // link straight to a driver's history: index.html?driver=DRV101
    let deep = '';
    try { deep = new URLSearchParams(location.search).get('driver') || ''; } catch (e) { /* old browser */ }
    if (deep.trim()) runHistory({ driverId: normId(deep) });
  }
  start();
})();
