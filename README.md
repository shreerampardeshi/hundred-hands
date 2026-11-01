# HUNDRED HANDS 🚨

Mobile-first emergency coordination web app. One family creates a case; many helpers
scan a QR code, get assigned hospitals (never the same one twice), call, and report
bed / specialist / blood / accepts results live to everyone on the same case link.

**All data lives in a real server-side SQLite database — no localStorage. Every phone
polls every 2 seconds and sees everyone else's updates live.**

## Screens
| Route | What it does |
|---|---|
| `/` | New case: condition, location, blood group, needs, flexible facility import (markdown / CSV / TSV), demo-hospital loader, Start Search |
| `/case/<id>` | Command dashboard: crisis card + live timer, QR code + copy helper link, live counters (hands / calls in progress / time saved), facility grid, auto BEST MATCH banner with "Copy for 108 driver" |
| `/case/<id>/help` | Helper view: enter name → auto-assigned next nearest unassigned facilities → tap-to-call (tel:) → call script on screen → YES / NO / UNSURE + No answer → Submit → "Take another hospital" |

Status colors: green = yes, red = no, yellow = unsure, blue = assigned/calling, gray = queued.

## Demo mode
"▶ Run demo mode" on the dashboard simulates 4 helpers (Asha, Rohan, Imran, Priya)
joining and results arriving over ~60 seconds, ending with a BEST MATCH banner.

## Run locally
```bash
node server.js        # zero dependencies, needs Node 22+ (built-in node:sqlite)
# open http://localhost:3000
```

## One-click deploy (free, with a persistent disk for the DB file)
The SQLite database must survive restarts — attach a persistent disk and point
`DB_PATH` at it.

**Render**
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: *(none)*  Start command: `node server.js`
4. Add a Disk: mount path `/data`, size 1 GB, and set env var `DB_PATH=/data/hundredhands.db`
5. Deploy. Share `https://<your-app>.onrender.com/case/<id>` with the family and `/case/<id>/help` via QR.

**Railway**
1. Railway → New Project → Deploy from GitHub repo.
2. Add a Volume mounted at `/data`; set `DB_PATH=/data/hundredhands.db`.
3. Start command `node server.js`. Done.

## API
```
POST /api/parse                 {text}                -> parsed facilities
POST /api/case                  {condition,location,blood_group,needs,facilities}
GET  /api/case/<id>             full live case state (poll every 2s)
POST /api/case/<id>/join        {name}                -> atomic assignment (nearest first, never doubled)
POST /api/case/<id>/demo        start server-side demo simulation
POST /api/facility/<id>/call    mark as calling
POST /api/facility/<id>/report  {bed,specialist,blood,accepts,notes}
```

## Concurrency guarantee
Helper assignment runs inside a `BEGIN IMMEDIATE` transaction with
`UPDATE ... WHERE assigned_to IS NULL`, so two helpers tapping at the same millisecond
can never receive the same facility (verified with concurrent tests).
