/* HUNDRED HANDS — emergency hospital-finder web app
 * Zero-dependency Node server (built-in http + node:sqlite).
 * All data lives in a real SQLite database file — no localStorage.
 * Every client polls every 2s and sees live updates. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'hundredhands.db');
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY, condition_txt TEXT, location TEXT, blood_group TEXT,
  needs TEXT, created_at INTEGER, demo INTEGER DEFAULT 0, status TEXT DEFAULT 'searching'
);
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT, name TEXT, phone TEXT, address TEXT,
  distance_km REAL, caller_type TEXT DEFAULT 'human', status TEXT DEFAULT 'queued',
  assigned_to TEXT, bed TEXT, specialist TEXT, blood TEXT, accepts TEXT, notes TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS helpers (
  case_id TEXT, name TEXT, joined_at INTEGER, PRIMARY KEY (case_id, name)
);
`);

const now = () => Date.now();
const rid = (n) => crypto.randomBytes(8).toString('hex').slice(0, n);

/* ---------- flexible paste parser: markdown tables, CSV, TSV ---------- */
function parseFacilities(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(\|?[\s:-]*-{2,}[\s|:-]*\|?\s*)$/.test(line)) continue;        // md separator row
    if (/^\|/.test(line) && /\|$/.test(line)) line.replace(/^\|/, '');
    let cells = null;
    if (line.includes('|')) cells = line.split('|').map(c => c.trim());
    else if (line.includes('\t')) cells = line.split('\t').map(c => c.trim());
    else if (line.includes(',')) cells = line.split(',').map(c => c.trim());
    else cells = [line];
    cells = cells.filter((c, i, a) => !(c === '' && (i === 0 || i === a.length - 1)));
    if (!cells.length || cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    const joined = cells.join(' ').toLowerCase();
    if (/^name/.test(joined) || /^facility/.test(joined)) continue;      // header row
    let name = cells[0] || '', phone = cells[1] || '', address = cells[2] || '', dist = cells[3] || '';
    // rescue: phone column may hold digits, distance may be anywhere
    if (!/[\d+]/.test(phone) || /[a-df-z]{4,}/i.test(phone)) {
      const m = line.match(/(\+?\d[\d\s\-()]{7,}\d)/);
      if (m) phone = m[1].trim();
      const rest = cells.slice(1).filter(c => c && !c.includes(name));
      if (rest.length && !address) address = rest.find(c => /[a-z]/i.test(c) && !/^\+?[\d\s\-()]+$/.test(c)) || '';
    }
    if (!dist) { const m = line.match(/([\d.]+)\s*(km|kilometres?|kilometers?)?/i); if (m) dist = m[1]; }
    const distKm = parseFloat(String(dist).replace(/[^\d.]/g, ''));
    if (!name || !phone) continue;
    out.push({
      name: name.replace(/^[-*]\s*/, ''),
      phone: phone.replace(/[^\d+\-() ]/g, '').trim(),
      address: String(address || '').replace(/^[-*]\s*/, ''),
      distance_km: isNaN(distKm) ? null : distKm
    });
  }
  return out.slice(0, 60);
}

/* ---------- DB-level guarantee: ONE assignment per facility ----------
 * Source of truth is the `assignments` table whose PRIMARY KEY is facility_id —
 * SQLite itself makes a second assignment of the same facility physically
 * impossible (INSERT fails with SQLITE_CONSTRAINT). The old
 * idx_one_helper_per_facility index wrongly also blocked a helper from taking
 * 2 facilities, so it is dropped. Startup migration back-fills the table from
 * any legacy facilities.assigned_to values. */
(function migrate() {
  db.exec('DROP INDEX IF EXISTS idx_one_helper_per_facility');
  db.exec(`CREATE TABLE IF NOT EXISTS assignments (
    facility_id INTEGER PRIMARY KEY,
    case_id TEXT NOT NULL,
    helper TEXT NOT NULL,
    assigned_at INTEGER
  )`);
  // legacy rows: mirror facilities.assigned_to into assignments (if not already there)
  const legacy = db.prepare(`
    SELECT f.id, f.case_id, f.assigned_to, f.updated_at FROM facilities f
    WHERE f.assigned_to IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.facility_id = f.id)`).all();
  for (const r of legacy) {
    try {
      db.prepare('INSERT INTO assignments (facility_id, case_id, helper, assigned_at) VALUES (?,?,?,?)')
        .run(r.id, r.case_id, r.assigned_to, r.updated_at || now());
    } catch (_) {} // raced with another process — the winner's row stays
  }
  if (legacy.length) console.log(`migration: back-filled ${legacy.length} legacy assignment(s) into assignments table`);
})();

function takenBy(caseId) {
  return db.prepare("SELECT helper FROM assignments WHERE case_id=? ORDER BY assigned_at DESC, facility_id DESC LIMIT 1")
    .get(caseId)?.helper || null;
}

/* ---------- helper assignment: atomic, never double-assign ----------
 * BEGIN IMMEDIATE serializes writers; claiming a facility is a single INSERT
 * into assignments (PK = facility_id), so even two requests in the same
 * millisecond cannot both win — the loser gets 409. */
function assignToHelper(caseId, helperName) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO helpers (case_id, name, joined_at) VALUES (?,?,?)').run(caseId, helperName, now());
    const cnt = db.prepare(`
      SELECT COUNT(*) c FROM facilities f
      WHERE f.case_id=? AND f.status='queued'
        AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.facility_id=f.id)`).get(caseId).c;
    if (cnt === 0) {
      db.exec('COMMIT');
      return { assigned: [], remaining: 0, taken_by: takenBy(caseId) };
    }
    const take = cnt >= 4 ? 2 : 1;
    const ids = db.prepare(`
      SELECT f.id FROM facilities f
      WHERE f.case_id=? AND f.status='queued'
        AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.facility_id=f.id)
      ORDER BY COALESCE(f.distance_km,9999), f.id LIMIT ?`).all(caseId, take).map(r => r.id);
    const assignedIds = [];
    for (const id of ids) {
      try {
        db.prepare('INSERT INTO assignments (facility_id, case_id, helper, assigned_at) VALUES (?,?,?,?)')
          .run(id, caseId, helperName, now());          // PK(facility_id) = the lock
      } catch (_) { continue; }                          // someone else claimed it first
      db.prepare("UPDATE facilities SET assigned_to=?, status='calling', updated_at=? WHERE id=?")
        .run(helperName, now(), id);                     // mirror for display
      assignedIds.push(id);
    }
    db.exec('COMMIT');
    const assigned = assignedIds.length
      ? db.prepare(`SELECT * FROM facilities WHERE id IN (${assignedIds.map(() => '?').join(',')})`).all(...assignedIds)
      : [];
    const remaining = db.prepare(`
      SELECT COUNT(*) c FROM facilities f
      WHERE f.case_id=? AND f.status='queued'
        AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.facility_id=f.id)`).get(caseId).c;
    return { assigned, remaining, taken_by: assigned.length ? null : takenBy(caseId) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    if (String(e.message).includes('constraint')) {
      return { assigned: [], remaining: 0, taken_by: takenBy(caseId), conflict: true };
    }
    throw e;
  }
}

/* ---------- case payload ---------- */
function getCase(id) {
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(id);
  if (!c) return null;
  const facilities = db.prepare('SELECT * FROM facilities WHERE case_id=? ORDER BY COALESCE(distance_km,9999), id').all(id);
  const hands = db.prepare('SELECT COUNT(*) c FROM helpers WHERE case_id=?').get(id).c;
  const best = facilities.filter(f => f.bed === 'yes' && f.accepts === 'yes')
    .sort((a, b) => (a.distance_km ?? 9999) - (b.distance_km ?? 9999))[0] || null;
  return {
    id: c.id, condition: c.condition_txt, location: c.location, blood_group: c.blood_group,
    needs: JSON.parse(c.needs || '[]'), created_at: c.created_at, status: best ? 'matched' : c.status,
    demo: !!c.demo, hands, facilities: facilities.map(f => ({
      id: f.id, name: f.name, phone: f.phone, address: f.address, distance_km: f.distance_km,
      caller_type: f.caller_type, status: f.status, assigned_to: f.assigned_to,
      bed: f.bed, specialist: f.specialist, blood: f.blood, accepts: f.accepts, notes: f.notes
    })),
    best_match: best ? { id: best.id, name: best.name, address: best.address, phone: best.phone } : null,
    server_time: now()
  };
}

/* ---------- demo mode (server-side, so every phone sees it) ---------- */
const demoTimers = {};
function startDemo(caseId) {
  if (demoTimers[caseId]) return;
  const at = (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { console.error('demo', e); } }, ms);
  const facs = db.prepare("SELECT * FROM facilities WHERE case_id=? ORDER BY COALESCE(distance_km,9999), id").all(caseId);
  const helpers = ['Asha', 'Rohan', 'Imran', 'Priya'];
  const plan = {}; // helper -> [facility ids]
  let hi = 0;
  for (const f of facs) { const h = helpers[hi % 4]; (plan[h] = plan[h] || []).push(f.id); hi++; }
  helpers.forEach((h, i) => at(1000 + i * 900, () => assignToHelper(caseId, h)));
  const script = [
    [0, 'yes', 'yes', 'yes', 'yes', 'Confirmed over phone, holding the bed.'],
    [1, 'unsure', 'unsure', 'no', 'no', 'Will call back in 15 minutes.'],
    [2, 'no', 'no', 'no', 'no', 'ICU full, referred elsewhere.'],
    [3, 'unsure', 'unsure', 'unsure', 'no', 'No answer after 30 seconds.'],
    [4, 'yes', 'no', 'yes', 'no', 'Bed free but no specialist tonight.'],
    [5, 'unsure', 'unsure', 'unsure', 'unsure', 'On hold for the duty doctor.']
  ];
  script.forEach((s, i) => {
    const [slot, bed, spec, blood, accepts, notes] = s;
    const fid = facs[i] && facs[i].id; if (!fid) return;
    const helper = helpers[i % 4];
    at(9000 + i * 6500, () => {
      if (i === 3) {
        db.prepare("UPDATE facilities SET bed='unsure', specialist='unsure', blood='unsure', accepts='no', notes=?, status='done', updated_at=? WHERE id=?").run(notes, now(), fid);
      } else {
        db.prepare("UPDATE facilities SET bed=?, specialist=?, blood=?, accepts=?, notes=?, status='done', updated_at=? WHERE id=?")
          .run(bed, spec, blood, accepts, notes, now(), fid);
      }
      void helper; void slot;
    });
  });
  at(62000, () => { delete demoTimers[caseId]; });
  demoTimers[caseId] = true;
}

/* ---------- routing ---------- */
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (_) { resolve({}); } }); }); }
function staticFile(res, p) {
  fs.readFile(path.join(PUBLIC, p), (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/api/parse') return json(res, 200, { facilities: parseFacilities((await readBody(req)).text) });

    if (req.method === 'POST' && p === '/api/case') {
      const b = await readBody(req);
      const id = 'HH-' + rid(6).toUpperCase();
      db.prepare('INSERT INTO cases (id, condition_txt, location, blood_group, needs, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, String(b.condition || ''), String(b.location || ''), String(b.blood_group || ''), JSON.stringify(b.needs || []), now());
      const ins = db.prepare('INSERT INTO facilities (case_id, name, phone, address, distance_km) VALUES (?,?,?,?,?)');
      for (const f of (b.facilities || [])) ins.run(id, f.name, f.phone, f.address || '', f.distance_km);
      return json(res, 200, { id });
    }

    let m;
    if ((m = p.match(/^\/api\/case\/([\w-]+)$/)) && req.method === 'GET') {
      const c = getCase(m[1]); return c ? json(res, 200, c) : json(res, 404, { error: 'case not found' });
    }
    if ((m = p.match(/^\/api\/case\/([\w-]+)\/join$/)) && req.method === 'POST') {
      const b = await readBody(req); const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return json(res, 400, { error: 'name required' });
      const r = assignToHelper(m[1], name);
      if (!r.assigned.length) {
        // every facility already belongs to another hand — 409, never a double assignment
        return json(res, 409, { error: 'facility_already_taken', taken_by: r.taken_by, helper: name });
      }
      return json(res, 200, { ...r, helper: name });
    }
    if ((m = p.match(/^\/api\/case\/([\w-]+)\/demo$/)) && req.method === 'POST') {
      db.prepare('UPDATE cases SET demo=1 WHERE id=?').run(m[1]);
      startDemo(m[1]); return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/facility\/(\d+)\/call$/)) && req.method === 'POST') {
      db.prepare("UPDATE facilities SET status='calling', updated_at=? WHERE id=? AND status='queued'").run(now(), +m[1]);
      return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/facility\/(\d+)\/report$/)) && req.method === 'POST') {
      const b = await readBody(req);
      db.prepare(`UPDATE facilities SET bed=?, specialist=?, blood=?, accepts=?, notes=?, status='done', updated_at=? WHERE id=?`)
        .run(String(b.bed || 'unsure'), String(b.specialist || 'unsure'), String(b.blood || 'unsure'),
             String(b.accepts || 'no'), String(b.notes || '').slice(0, 300), now(), +m[1]);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      if (p === '/') return staticFile(res, 'index.html');
      if ((m = p.match(/^\/case\/([\w-]+)$/))) return staticFile(res, 'case.html');
      if ((m = p.match(/^\/case\/([\w-]+)\/help$/))) return staticFile(res, 'help.html');
      if (p.startsWith('/')) return staticFile(res, p.replace(/^\/+/, '') || 'index.html');
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { console.error(e); json(res, 500, { error: 'server error' }); }
});
server.listen(PORT, () => console.log(`HUNDRED HANDS listening on :${PORT}`));
