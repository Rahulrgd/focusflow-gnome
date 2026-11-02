# FocusFlow — GNOME Shell Extension Plan

> Target: Zorin OS 18.1 · GNOME Shell 46 (Wayland) · GJS 1.80 · libadwaita 1.5
> UUID: `focusflow@rahulrgd.github.io`
> Schema: `org.gnome.shell.extensions.focusflow`
> Started: 2026-11-02 · Branch: `step_1`

## Progress Tracker

| #  | Phase                                         | Status         | Notes |
|----|-----------------------------------------------|----------------|-------|
| 0  | Setup & skeleton                              | ✅ Done        | Enable/disable/re-enable + prefs window verified in headless shell; real-session check pending |
| 1  | Data layer (topics, sessions, pure modules)   | ✅ Done        | 28 unit tests pass; seeding, add, append, external reload, re-enable verified in headless shell |
| 2  | Timer engine                                  | ✅ Done        | 45 unit tests pass; 1-min finish, pause, disable/enable verified in headless shell |
| 3  | Panel indicator + Section 1 (Timers)          | ✅ Done        | Menu driven in headless shell (11 checks) + screenshots (docs/menu.png); real-session check pending |
| 4  | Preferences: Manage Topics (Section 2)        | ✅ Done        | 12 prefs harness checks + menu→window and cross-process delete verified in headless shell; real drag pending |
| 5  | Stats & graph (Section 3)                     | ✅ Done        | 57 unit tests (3 timezones); seeded history driven in headless shell + screenshots |
| 6  | Notifications, sound & panel label            | ✅ Done        | 58 unit tests; real finish, late finish, DND, off switches, icon-only panel verified headless; audible check pending |
| 7  | Settings, auto-chain, shortcut, daily goal    | ✅ Done        | 30 prefs checks + real 1-min auto-start, Start Break, goal ✓, shortcut (virtual keyboard) verified headless |
| 8  | Export / Import                               | ✅ Done        | 66 unit tests; 14 Backup-page checks + clear-timers shell test via scripts/headless.sh; file pickers manual check pending |
| 9  | Lock screen, suspend, robustness & polish     | ✅ Done        | Lock-screen finish, overdue-after-suspend, broken files, 30k sessions, Tab nav, 10× enable cycles, ZorinBlue-Dark verified headless; real suspend/lock pending |
| 10 | Packaging, testing & release                  | 🟨 In progress | Zip, README, LICENSE, v1.0.0, fresh-install smoke test done; real-session checks + tag pending |

Status legend: ⬜ Not started · 🟨 In progress · ✅ Done · ⛔ Blocked

---

## 1. Overview

FocusFlow top panel me ek timer icon dikhata hai. Uske dropdown menu me teen sections hain:

1. **Timers:** har visible topic ki ek row: `Name | minutes | ▶ ⏸ ↺`
2. **Manage Topics:** ek button jo preferences window kholta hai (add/edit/delete/hide/reorder)
3. **Stats:** `Daily | Weekly | Monthly` tabs aur har topic ka total time bars me

Timer chalte waqt panel me icon ke saath countdown dikhta hai (jaise `Study 23:41`). Timer pura hone par desktop notification aur sound aata hai, aur session history me log ho jata hai. Ye sab browser se alag, poore desktop par kaam karta hai.

### Architecture

```
┌──────────────────────── gnome-shell process ─────────────────────────┐
│                                                                       │
│  extension.js ──► Indicator (PanelMenu.Button)                        │
│       │             ├─ panel: icon + "Study 23:41" label              │
│       │             ├─ Section 1: TimerList (rows, scrollable)        │
│       │             ├─ ── separator ──                                │
│       │             ├─ Section 2: "Manage Topics" → openPreferences() │
│       │             ├─ ── separator ──                                │
│       │             └─ Section 3: StatsView (tabs, ‹ › , bars)        │
│       │                                                               │
│       ├─► TimerEngine (timestamps, 1 s tick, finish → events)         │
│       ├─► Notifier (MessageTray source + sound)                       │
│       ├─► SessionStore ──► ~/.local/share/focusflow/sessions.jsonl    │
│       └─► Gio.Settings (topics, active timer, settings) ◄──┐          │
└────────────────────────────────────────────────────────────┼──────────┘
                                                             │ GSettings (dconf)
┌──────────────────── prefs.js (alag gjs process) ───────────┼──────────┐
│  Adw.PreferencesWindow                                     │          │
│    ├─ Topics page   (add / edit / delete / hide / reorder) ┘          │
│    ├─ Settings page (sound, notifications, week start, auto-chain…)   │
│    └─ Backup page   (export / import JSON, export CSV)                │
│                     └─► sessions.jsonl bhi padh/likh sakta hai        │
└───────────────────────────────────────────────────────────────────────┘
```

### Key decisions

**D1. `PanelMenu.Button` ya Quick Settings? → `PanelMenu.Button`**
- Teen sections, inline minutes entry aur graph Quick Settings ke chhote toggle me fit nahi hote.
- Apne menu me layout, width aur scroll par poora control milta hai.
- Panel label me countdown dikha sakte hain. Chrome version ka "badge" yahi hai.

**D2. Data kahan rakhein? → do jagah**
- **GSettings:** topics (JSON string), active timer, saari settings. Ye chhota data hai, aur extension aur prefs (alag process) dono ise padh sakte hain. `changed` signal se dono taraf UI turant update hota hai.
- **`~/.local/share/focusflow/sessions.jsonl`:** session history. Ye data hamesha badhta rahega, aur dconf bade data ke liye nahi bana. Har line ek session hai. Naya session file ke end me **append** hota hai, poori file dobara nahi likhni padti. Isliye crash me data kharab hone ka risk kam hai, aur prefs ke saath takraav bhi kam hai.
- Delete-history aur import poori file dobara likhte hain (temp file + rename, `Gio.File.replace_contents`). Extension `Gio.FileMonitor` se file change dekh kar apna cache reload karta hai.

**D3. Timer timestamps par chalega, ticks par nahi**
- Running: `{ topicId, topicName, status: "running", durationMs, startedAt, remainingMsAtStart }` → remaining = `remainingMsAtStart - (Date.now() - startedAt)`.
- Paused: `{ topicId, topicName, status: "paused", durationMs, remainingMs, pausedAt }`.
- Ye state GSettings key `timers` me save hoti hai (topic id → timer ka map). Shell restart, extension disable/enable ya logout ke baad bhi timer sahi jagah se chalega.
- 1-second `GLib.timeout_add` sirf UI redraw aur finish check ke liye hai. GLib ke timeouts suspend ke dauran ruk jaate hain, isliye har tick par **wall-clock** (`Date.now()`) se check karte hain ki timer khatam hua ya nahi.

**D4. Ek waqt par ek hi timer *chalega*, par har topic apna paused progress rakhega.** Doosra topic start karne par pehla wala pause ho jata hai (uska ab tak ka time log hota hai), aur wapas aane par wahin se resume hota hai. Isliye state ek `active-timer` nahi, balki `timers` map hai: har topic ki ek entry, unme se max ek `running`. *(Phase 2 me badla: pehle sirf ek `active-timer` tha, jisse switch karne par pichhle topic ka progress kho jata.)*

**D5. Session har "run segment" par log hoga**
- Jab bhi timer rukta hai (pause, reset, doosra topic start, ya finish), us segment ka actual chala hua time ek session entry me jata hai.
- Sirf wo segment jo 0 tak pahuncha, `completed: true` hota hai.
- Isse adhure ya pause kiye timers ka time bhi graph me sahi aata hai.
- Har session me `topicName` ka snapshot bhi save hoga, taaki delete ho chuke topic ka naam graph me dikh sake.
- Midnight cross karne wala session us din me ginega jis din wo shuru hua tha (simple rakha hai).

**D6. Lock screen → `session-modes: ["user", "unlock-dialog"]`**
- Pomodoro chalate waqt screen lock karna aam baat hai. Lock par extension disable ho gaya toh timer ka notification/sound unlock ke baad hi aayega.
- Isliye engine lock screen par bhi chalta rahega, par **indicator lock screen par hide** hoga (privacy + extension review rule). `Main.sessionMode` ke `updated` signal par handle karenge.

**D7. Preferences window = Section 2 (Manage Topics)**
- Shell menu me drag-and-drop, color picker aur confirmation dialog sahi se nahi bante. libadwaita (`Adw.PreferencesWindow`) me ye sab native milta hai.
- Reorder: `Gtk.DragSource` + `Gtk.DropTarget` drag handle se, aur ▲/▼ buttons keyboard fallback ke liye.

**D8. Graph menu me St widgets se banega, Cairo se nahi**
- Har topic ki ek horizontal bar: `St.Bin` jiski width = `total / max × maxWidth`, background = topic color. Koi library nahi chahiye, aur theme ke saath achha dikhega.
- Bada/detailed graph (stacked by day) baad me prefs ke Stats page me `Gtk.DrawingArea` + Cairo se ban sakta hai (backlog).

**D9. Pure logic alag modules me**
- `timerMath.js`, `stats.js`, `topicsModel.js` me koi Shell/GTK import nahi hoga. Inhe `gjs -m tests/run.js` se seedha terminal me test kar sakte hain, bina shell restart kiye.

**D10. Sound** → `global.display.get_sound_player().play_from_file()` (extension ki apni `sounds/done.oga`). File nahi mili toh fallback `play_from_theme('complete', …)`.

---

## 2. Project Structure

```
focusflow/
├── PLAN.md
├── README.md
├── LICENSE
├── metadata.json             # uuid, name, shell-version ["46"], session-modes, settings-schema
├── extension.js              # Extension class: enable()/disable(), sab ko wire karta hai
├── prefs.js                  # Adw.PreferencesWindow: Topics, Settings, Backup pages
├── stylesheet.css            # rows, active row highlight, progress bar, stats bars
├── lib/
│   ├── indicator.js          # PanelMenu.Button, panel label, menu sections jodna
│   ├── timerList.js          # Section 1: topic rows (name, minutes entry, buttons, progress)
│   ├── statsView.js          # Section 3: tabs, ‹ › navigation, summary, bars
│   ├── timerEngine.js        # start/pause/reset/toggle, tick, finish, signals (GObject)
│   ├── sessionStore.js       # sessions.jsonl: append, read, rewrite, file monitor
│   ├── topicsStore.js        # GSettings 'topics' JSON <-> objects, seed defaults
│   ├── notifier.js           # MessageTray source, notifications + actions, sound
│   ├── timerMath.js          # (pure) remaining, finished?, segment → session
│   ├── stats.js              # (pure) period ranges, prev/next, aggregate
│   ├── topicsModel.js        # (pure) validate, reorder, add/update/delete helpers
│   ├── migrate.js            # SCHEMA_VERSION, migrateData() (import ke liye bhi), migrateSettings()
│   └── format.js             # (pure) "MM:SS", "2h 15m", period labels
├── prefs/
│   ├── topicsPage.js         # list, drag reorder, ▲▼, edit dialog, hide, delete dialog
│   ├── settingsPage.js       # sound, notifications, week start, auto-chain, shortcut
│   └── backupPage.js         # export JSON/CSV, import (replace/merge), reset all
├── sounds/
│   └── done.oga              # apna chime, scripts/make-sound.py se bana
├── docs/
│   ├── menu.png              # README ke liye screenshot (panel menu, teeno sections)
│   ├── prefs.png             # README ke liye screenshot (Manage Topics)
│   ├── menu-dark.png         # README ke liye screenshot (ZorinBlue-Dark theme)
│   └── notification.png      # README ke liye screenshot (finish banner)
├── icons/
│   └── focusflow-symbolic.svg
├── schemas/
│   └── org.gnome.shell.extensions.focusflow.gschema.xml
├── tests/
│   └── run.js                # gjs -m tests/run.js → pure modules ke unit tests
└── scripts/
    ├── install.sh            # schemas compile + ~/.local/share/gnome-shell/extensions me symlink
    ├── nested.sh             # nested Wayland session
    ├── make-sound.py         # sounds/done.oga generate karta hai (ffmpeg/libvorbis)
    └── pack.sh               # gnome-extensions pack → dist/
```

### GSettings keys (draft)

| Key                       | Type | Default              | Purpose |
|---------------------------|------|----------------------|---------|
| `schema-version`          | `i`  | `1`                  | Data migrations ke liye |
| `topics`                  | `s`  | `'[]'`               | Topics ka JSON array (neeche dekho) |
| `seeded`                  | `b`  | `false`              | Default topics ek baar hi add hon |
| `timers`                  | `s`  | `'{}'`               | Topic id → running/paused timer ka JSON map (max ek running) |
| `purge-topic-ids`         | `as` | `[]`                 | "Delete History" ki request: prefs likhta hai, shell purge karke khali karta hai |
| `clear-timers`            | `b`  | `false`              | Import Replace / Reset ki request: shell saare timers bina log kiye hatata hai, phir `false` |
| `last-topic-id`           | `s`  | `''`                 | Shortcut se kaunsa topic resume/start ho |
| `sound-enabled`           | `b`  | `true`               | Finish par sound |
| `notifications-enabled`   | `b`  | `true`               | Finish par notification |
| `panel-show-countdown`    | `b`  | `true`               | Panel me `Study 23:41` label |
| `week-start`              | `s`  | `'mon'`              | `mon` / `sun` |
| `stats-period`            | `s`  | `'daily'`            | Menu me last chuna hua tab |
| `auto-chain-enabled`      | `b`  | `false`              | Focus ke baad break auto start |
| `auto-chain-from`         | `as` | `[]`                 | Kin topics ke baad chain ho |
| `auto-chain-to`           | `s`  | `''`                 | Kaunsa topic start ho |
| `toggle-timer`            | `as` | `['<Super><Alt>p']`  | Pause/resume shortcut |

### Data shapes

```js
// GSettings 'topics' (JSON string)
[{ id, name, minutes, color: "#e66100", hidden: false, order: 0, dailyGoalMinutes: null }]

// GSettings 'timers' (JSON map; idle topics ki entry nahi hoti)
{ "<topicId>": { topicId, topicName, status: "running", durationMs, startedAt, remainingMsAtStart },
  "<topicId>": { topicId, topicName, status: "paused",  durationMs, remainingMs, pausedAt } }

// ~/.local/share/focusflow/sessions.jsonl (har line ek JSON object)
{ "id": "…", "topicId": "…", "topicName": "Study", "start": 1762070400000,
  "end": 1762073100000, "seconds": 2700, "completed": true }
```

IDs `GLib.uuid_string_random()` se banenge. Default topics: Study 45, Break 5, Gaming 30, YouTube 15 (har ek ka alag color).

---

## 3. Phases

### Phase 0 — Setup & skeleton
**Goal:** Ek khali extension jo nested session me enable ho jaye aur bina error ke disable ho jaye.

- [x] `metadata.json` (`uuid`, `name`, `description`, `shell-version: ["46"]`, `session-modes`, `settings-schema`, `url`, `version-name`)
- [x] ESM `extension.js`: `export default class FocusFlowExtension extends Extension { enable() {} disable() {} }`
- [x] ESM `prefs.js`: `ExtensionPreferences` + `fillPreferencesWindow()` ek khali page ke saath
- [x] GSettings schema XML me upar ki saari keys, phir `glib-compile-schemas schemas/`
- [x] `scripts/install.sh`, `scripts/nested.sh`, `scripts/pack.sh` (background-music-player wale scripts jaise)
- [x] `.gitignore`: `schemas/gschemas.compiled`, `*.zip`, `dist/`
- [x] Symbolic panel icon `icons/focusflow-symbolic.svg`

**Done when:** Nested session me `gnome-extensions enable focusflow@rahulrgd.github.io` chale, `gnome-extensions prefs …` window khule, aur `journalctl` me koi error na aaye.

**Result (2026-11-02):** Isolated headless shell (alag XDG dirs + keyfile settings, asli desktop untouched) me `ACTIVE → INACTIVE → ACTIVE` sahi chala, log me sirf `enabled (schema v1)` / `disabled`, koi JS error nahi. `prefs.js` GJS harness me load hua: window visible, settings bound, Topics page mila. Schema `glib-compile-schemas --strict` se pass, `scripts/pack.sh` zip bana. Asli session me (`./scripts/install.sh` + logout/login) check baaki.

---

### Phase 1 — Data layer (topics, sessions, pure modules)
**Goal:** Saara data padhna/likhna bharosemand ho, aur pure logic ke unit tests pass hon.

- [x] `topicsModel.js` (pure): `validateTopic`, `addTopic`, `updateTopic`, `deleteTopic`, `reorder(idsInOrder)`, `toggleHidden`, `visibleSorted`
  - Name: trim, empty nahi, duplicate nahi (case-insensitive) · minutes: integer 1–600 · color: valid hex
- [x] `topicsStore.js`: GSettings `topics` ⇄ array, `changed::topics` signal, pehli baar `seeded = false` ho toh defaults daalo
- [x] `sessionStore.js`:
  - [x] `~/.local/share/focusflow/` folder banao (`GLib.get_user_data_dir()`)
  - [x] `append(session)`: async, `Gio.File.append_to_async`, ek line (`GLib.Bytes` ke saath, neeche note dekho)
  - [x] `loadAll()`: file padh kar parse karo, kharab line skip + warning
  - [x] `rewrite(sessions)`: temp + rename (`replace_contents_async`)
  - [x] `Gio.FileMonitor` → `changed` signal (prefs ne file badli toh cache reload)
- [x] `schema-version` + `migrate()` (v1 me no-op, par wired) → `lib/migrate.js`, `enable()` me call hota hai
- [x] `tests/run.js`: chhota assert helper + `topicsModel` ke tests

**Done when:** `gjs -m tests/run.js` pass ho. Looking Glass (`Alt+F2` → `lg`) se topics add/edit karne par `dconf read /org/gnome/shell/extensions/focusflow/topics` me sahi JSON dikhe, aur ek test session `sessions.jsonl` me likha jaye.

**Result (2026-11-02):** `gjs -m tests/run.js` → 28 passed (5 baar chala, flaky nahi). Isolated headless shell me: 4 default topics seed hue, `seeded = true`; `add()` ka topic dconf me gaya; `append()` se `sessions.jsonl` me 1 line; bahar se file rewrite karne par cache 3 s ke andar reload hua; disable/enable ke baad 5 topics + 2 sessions bache, defaults dobara nahi aaye. Shell log me koi JS error nahi. Looking Glass wala manual check asli session me baaki.

**Notes (jo implement karte waqt pata chala):**
- GJS ka `write_all_async` JS buffer ko write khatam hone tak zinda nahi rakhta. 50 parallel appends me 6 lines kharab hui thi. Fix: `GLib.Bytes` + `write_bytes_async`.
- Khali `GLib.Bytes` GIO ko NULL buffer jaisa milta hai aur write kabhi complete nahi hota (`rewrite([])` hang). Fix: khali file ke liye `replace_async` stream khol kar band karna.
- `replace_contents_bytes_async` ka finish function `replace_contents_finish` hai, `_promisify` ko naam dena padta hai.
- Apne writes se aane wale FileMonitor events size + mtime "stamp" se pehchane jaate hain, taaki apne hi append par dobara reload na ho.
- GJS me `console` read-only hai, tests me stub nahi ho sakta. Expected warnings test output me dikhti hain.

---

### Phase 2 — Timer engine
**Goal:** UI ke bina, ek sahi chalne wala timer jo restart ke baad bhi apni jagah se chale.

- [x] `timerMath.js` (pure): `remainingMs`, `progress`, `finishAt`, `isFinished`, `startTimer`, `pauseTimer`, `resumeTimer`, `segmentToSession`, `parseTimers`, `runningTimer`, `lastPausedTimer` + unit tests
- [x] `timerEngine.js` (GObject, signals: `changed`, `tick`, `finished(session, late)`):
  - [x] `start(topicId)`: koi aur chal raha hai toh pehle use pause + log karo; paused topic par `start` = resume
  - [x] `pause()`: segment log (`completed: false`), `remainingMs` save
  - [x] Resume: `start()` hi karta hai, naya `startedAt`
  - [x] `reset(topicId)`: chal raha tha toh segment log, phir us topic ki entry hatao
  - [x] 1 s tick sirf jab timer running ho; tick par `Date.now()` se finish check
  - [x] Finish: segment `completed: true` (end = `finishAt`, `now` nahi), `last-topic-id` set, `finished` signal
  - [x] `toggle()` (shortcut ke liye): running → pause · warna sabse recent paused → resume · warna last topic → start · warna pehla visible topic
  - [x] Topic delete hua → uska timer hatao (running tha toh segment log)
- [x] `enable()` par `timers` padho → `checkFinished()`: time nikal chuka hai toh sahi end time ke saath finish (`late = true`); baaki tick dobara shuru
- [x] `disable()` par tick source aur topics signal handler hatao (review requirement)
- [x] Decide: chalte timer ke minutes badle toh kya ho → **sirf agle start par lagega** (`durationMs` start par fix)

**Done when:** Looking Glass se 1 minute ka timer start karo, aur wo khatam hone par `sessions.jsonl` me `completed: true` aaye. 20 s baad pause karo → 20 s ka `completed: false` session aaye. Timer chalte hue extension disable/enable karo → remaining time sahi rahe.

**Result (2026-11-02):** `gjs -m tests/run.js` → 45 passed (3 baar). Unit tests me fake clock se: pause/resume gap, topic switch, reset, late finish, restart (3 engine instances, ek hi settings), topic delete, minutes edit, toggle ke 4 cases, asli main loop par tick se finish, `finished` handler se agla timer start (auto-chain) aur `destroy()`. Isolated headless shell me asli time ke saath: 1-min timer khud finish hua (60 s, `completed`, `late: false`, tick source band); 20 s pause → 280 s bache; resume → disable 5 s → enable, timer chalta raha aur remaining wall-clock ke hisaab se ~6 s kam. `sessions.jsonl`: `Quick 60 s completed`, `Break 20 s partial`, `Break 10 s partial`. Shell log me koi JS error nahi.

**Notes:**
- **Data-loss bug mila aur fix hua:** `SessionStore.destroy()` cancellable cancel karta tha, jisse queue me pada append bhi cancel ho jata. Matlab pause ke turant baad logout/disable hua toh wo session kho jata. Ab sirf reads cancellable hain; writes hamesha poore hote hain (test: "queued writes still land").
- `checkFinished()` constructor me nahi chalta, taaki `finished` signal tab aaye jab koi sun raha ho (Phase 6 me restart ke baad wala notification isi par).
- Disable ke dauran timer "chalta" rehta hai (wall clock), kyunki disable kuch log nahi karta. Lock screen par disable hota hi nahi (`unlock-dialog`).
- Tick source apne callback ke andar se bhi safely band/replace hota hai (finish ke turant baad auto-chain wala case).

---

### Phase 3 — Panel indicator + Section 1 (Timers)
**Goal:** Menu se timers chala sakein.

- [x] `indicator.js`: `PanelMenu.Button`, icon + label (idle me sirf icon), `Main.panel.addToStatusArea(uuid, …, 0, 'right')`
- [x] Menu me teen sections + `PopupSeparatorMenuItem` (Section 3 abhi placeholder)
- [x] `timerList.js`: har visible topic (order se) ki row (`St.BoxLayout`, `PopupMenuSection` ke andar `St.ScrollView` me):
  - [x] Color dot · Name · minutes `St.Entry` · ▶ / ⏸ · ↺ (`St.Button` + symbolic icons)
  - [x] Minutes entry: sirf digits, Enter ya focus-out par validate + save, galat value par purani value wapas
  - [x] Active row: highlight, `MM:SS` countdown, neeche patli progress bar (topic ke color me)
  - [x] Button states: running me ▶ ki jagah ⏸; paused topic par ▶ = resume; idle me ↺ dim aur disabled
- [x] Bahut topics hon toh Section 1 `St.ScrollView` me (`max-height: 22em`)
- [x] Topics badle (prefs se bhi) ya engine `changed` de toh rows update; order/visible set badle tabhi rebuild (warna entry ka focus na toote); countdown engine ke `tick` par, sirf jab menu khula ho
- [x] Empty state: "No visible topics"
- [x] **Section 2:** "Manage Topics…" item → `openPreferences()`, menu band ho
- [x] Panel par middle-click → `engine.toggle()`
- [x] Panel label: running `Study 23:41`, paused `⏸ Study 12:05` (sabse recent paused), idle sirf icon *(Phase 6 se pehle hi basic version)*
- [x] Lock screen par indicator hide (`Main.sessionMode` `updated`)
- [x] `lib/format.js`: `formatClock` ("45:00", "1:30:00", round up) + `formatDuration` ("2h 15m", Phase 5 ke liye) + tests

**Done when:** Menu se kisi bhi topic ko run/pause/reset kar sakein. Menu band karke dobara kholne par sahi remaining time dikhe. Doosra topic start karne par pehla pause ho jaye.

**Result (2026-11-02):** Unit tests 47 passed. Isolated headless shell me menu ko Eval se chalaya (buttons ko `clicked` emit, entry me text + `activate`):
Study ▶ → row highlight, countdown `44:58`, panel `Study 44:58` · Break ▶ → Study paused (`Resume`, 44:58 bacha), panel `Break 05:00` · Break ⏸ → panel `⏸ Break 04:59` · Study ↺ → entry wapas `45` · Gaming minutes `12` save, `0`/`999` reject hokar `12` wapas, letters type nahi hote · menu band/khol → paused time same · YouTube hide → 3 rows, naya topic → turant row, sab hide → "No visible topics" · lock-screen mode → indicator hidden, menu band · disable/enable → ek hi indicator, paused Break bacha. Shell log me koi JS error nahi. Screenshot: `docs/menu.png`. Asli session me (asli mouse/keyboard, Zorin theme) check baaki; "Manage Topics…" ka window Phase 4 me test hoga.

**Notes:**
- Pehle rows ko non-reactive `PopupBaseMenuItem` me rakha tha (music player jaisa), par St non-reactive widget ko `:insensitive` mark karta hai aur theme andar ka saara text grey kar deta hai. Isliye `PopupMenuSection` use kiya.
- Normal (reactive) menu item hover par key focus le leta hai, jo minutes entry me type karte waqt focus chheen leta. Rows menu items nahi hain, isliye ye problem nahi aati.
- `St.Button` ka `clicked` signal ek argument (mouse button) leta hai; test me `emit('clicked', 1)`.

---

### Phase 4 — Preferences: Manage Topics (Section 2)
**Goal:** Topics ka poora add/edit/delete/hide/reorder prefs window me.

- [x] `prefs/topicsPage.js`: `Adw.PreferencesPage` → upar **"+ Add Topic"** button (group header me), neeche topics ki list
- [x] Har row (`Adw.ActionRow`): drag handle · color swatch · Name · "45 min" · ▲ ▼ · Edit · Hide/Show · Delete
- [x] Add/Edit dialog (`Adw.Dialog`): `Adw.EntryRow` (name, Enter = save), `Adw.SpinRow` (minutes, 1–600), `Gtk.ColorDialogButton` (color); daily goal Phase 7 me
- [x] Drag-and-drop reorder: `Gtk.DragSource` + `Gtk.DropTarget` poori row par (handle sirf visual hint) → upar/neeche aadhe ke hisaab se `reorder()`
- [x] Hide/Show toggle: hidden row ka naam + swatch dim, subtitle me "Hidden"; hidden topics graph me dikhte rahenge
- [x] Delete: `Adw.AlertDialog` → history ho toh **Keep History** / **Delete History** / Cancel, warna sirf **Delete** / Cancel
  - [x] Active topic delete → shell ka engine `topics` change par timer hatata hai (running segment log)
  - [x] Delete History → `purge-topic-ids` me id, phir topic delete; shell timer ko bina log kiye hatata hai, `removeTopics()` se history purge karta hai, key khali karta hai
- [x] Duplicate/galat naam par dialog me inline error + Save disabled; save/delete par `Adw.Toast`
- [x] Shell menu se topics badle (minutes edit etc.) toh window ki list turant rebuild

**Done when:** Add, edit, reorder (drag + buttons), hide/show aur delete sab kaam karein, aur khula hua panel menu turant update ho.

**Result (2026-11-02):** Unit tests 49 passed (`removeTopics`, `engine.forget` naye). Prefs GJS harness (headless display) → 12/12: ▲▼ aur ends par disable, drop se upar/neeche/khud par, hide/show, add (empty → disabled, "study" duplicate → error, "Reading" add), edit (prefilled, Enter se save, id same), delete bina history (sirf Delete), delete 2 sessions ke saath (Keep/Delete History, purge id queue), bahar se change par rebuild, empty state, window band hone ke baad changes safe. Headless shell (isolated dconf) me: menu ka "Manage Topics…" → asli "FocusFlow" window khuli, menu band hua; running Study + history ke saath Delete History → history aur timer gaye, menu se row gayi; Keep History → history bachi; extension disabled hote hue queue hua purge → enable par chala. Shell log me koi JS error nahi. Screenshot: `docs/prefs.png`. Asli mouse se drag-and-drop aur color picker dialog manual check baaki.

**Notes:**
- **Design change:** Delete History ka purge prefs nahi, shell karta hai (`purge-topic-ids` key). Pehle plan prefs se `rewrite()` ka tha, par running timer ka last segment shell turant log karta, jo purge ke baad file me aa sakta tha; aur window jaldi band hone par delayed purge kho jata.
- Test harness me top-level `await` ke baad `loop.run()` nested ho toh GJS ke promise jobs nahi chalte. Harness me sab kuchh `main()` ke andar, `loop.run()` top level par.
- Keyfile GSettings backend (purane headless tests) me har writer poori file likhta hai, isliye do processes ek saath likhein toh ek ka change ud jata hai. Asli dconf per-key likhta hai. Ab headless tests isolated dconf (`XDG_CONFIG_HOME` temp) par chalte hain; asli `~/.config/dconf/user` me koi FocusFlow key nahi gayi (check kiya).
- Error label dikhne par libadwaita 1.5 `AdwBreakpointBin ... natural size must be >= min size` warning deta hai; harmless.

---

### Phase 5 — Stats & graph (Section 3)
**Goal:** Menu me har topic ka total time, Daily / Weekly / Monthly.

- [x] `stats.js` (pure) + unit tests:
  - [x] `periodRange(type, anchor, weekStart, now)` → `{ start, end, label }` ("Today", "Yesterday", "Sat, 31 Oct", "This week", "Last week", "19 Oct – 25 Oct", "This month", "October 2026", "All time")
  - [x] `shiftPeriod(type, anchor, ±1)` (31 Jan + 1 month = February) + `isCurrentPeriod()`
  - [x] `aggregate(sessions, range, topics)` → `rows` (zero wale nahi, sabse zyada upar), `totalSeconds`, `completedCount`
- [x] `statsView.js`:
  - [x] Tabs: **Daily | Weekly | Monthly | All** (toggle `St.Button`s), last tab `stats-period` me yaad rahe
  - [x] **‹  label  ›** navigation; current period par `›` disabled; "All" me arrows hidden
  - [x] Summary: "Total 2h · 3 completed"
  - [x] Har topic ki horizontal bar: name · color bar (sabse bade total ke hisaab se) · "1h 30m"
  - [x] Delete ho chuke topic (history rakhi) → aakhri logged naam, grey italic, grey bar *(plan me "(deleted)" suffix tha; 340 px menu me naam kat jata tha)*
  - [x] Empty state: "No time logged for this period"
- [x] Menu khulne par current period par wapas; menu khula ho tabhi refresh (tick, naya session, `week-start` change). Bar rows reuse hote hain, isliye har second refresh sasta hai.
- [x] Chal raha segment (abhi tak ka time) live total me
- [-] *(Optional)* Weekly stacked-by-day view → backlog (prefs Stats page)
- [x] Naye topics ko 10-color palette se pehla unused color (`nextColor`), taaki 5th topic Study jaisa blue na ho

**Done when:** Aaj, is hafte aur is mahine ke totals `sessions.jsonl` ke raw data se match karein. Pichhle periods par jaana kaam kare. Week start setting ka asar dikhe.

**Result (2026-11-02):** Unit tests 57 passed, teen timezones me (IST, Europe/Berlin, America/New_York; DST wale din bhi). Headless shell me seeded history (aaj Study 1h 30m + Break 10m + deleted "Chess" 20m, kal Gaming 2h, pichhle mahine YouTube 30m) ke saath: Today `Total 2h · 3 completed` · ‹ Yesterday `Gaming 2h` · › aaj par ruk jata hai · This week (Mon start) 2h, Sunday start par kal ka Gaming bhi → 4h · This month 4h, ‹ October 2026 30m · All time 4h 30m, arrows hidden · tab menu dobara kholne par yaad · chal raha Reading 3s → 5s live, pause par log. Shell log me koi JS error nahi. Screenshot: `docs/menu.png` (teeno sections).

**Notes:**
- **Bug mila (Phase 3 se bhi):** `BinLayout` me khali fill widget ko `y_expand` ke bina 0 px height milti hai, isliye bars aur timer row ki progress bar dikhti hi nahi thi. Dono me `y_expand: true`.
- Saari date math local calendar se (`new Date(y, m, d + 1)`), "+24 h" se nahi, taaki DST wale din 23/25 ghante ke bhi sahi rahein.
- Missing folder par GIO file monitor polling par chalta hai (~4 s delay), phir bhi reload hota hai.

---

### Phase 6 — Notifications, sound & panel label
**Goal:** Timer khatam hone par saaf feedback.

- [x] `notifier.js`: GNOME 46 API → `new MessageTray.Source({title: 'FocusFlow', icon})`, `Main.messageTray.add(source)`, `new MessageTray.Notification({source, title, body, urgency: HIGH})`, `source.addNotification()`
- [x] Finish par: "Study finished" + "1h 30m of Study today" (aaj ka total, sirf aakhri segment nahi); late finish par "Ended at 14:32 · …" (system ka 12h/24h format) (`notifications-enabled` ka dhyan)
- [x] Notification action: **Start Again** · **Start Break** Phase 7 me (auto-chain ke saath)
- [x] Sound: apna chime `sounds/done.oga` (`scripts/make-sound.py` se bana, koi third-party license nahi), file na mile toh theme ka `complete` (`sound-enabled` ka dhyan)
- [x] Sound notification se alag bajta hai, isliye notifications off ya Do Not Disturb me bhi bajta hai (sirf FocusFlow ki "sound" setting se band hota hai)
- [x] Panel label: running `Study 23:41` · paused `⏸ Study 12:05` · idle sirf icon *(Phase 3 me bana)*; `panel-show-countdown` off → sirf icon: running par accent color, paused par dim
- [x] Label me tabular numbers (`tnum`), taaki digits badalne par chaudai na hile
- [x] `disable()` par notification source destroy

**Done when:** Menu band ho tab bhi timer khatam hone par notification aaye, sound baje, aur panel label sahi countdown dikhaye. Zorin ka Do Not Disturb on ho toh banner na aaye, par notification list me dikhe.

**Result (2026-11-02):** Unit tests 58 passed. Headless shell me (sound player par counter laga kar, kyunki headless me audio nahi):
asli 1-min timer khud khatam → `done.oga` baja, banner "Quick finished / 1m of Quick today" (urgency HIGH, action "Start Again") · Start Again → naya 1-min timer · extension band hote hue timer khatam (shell restart jaisa) → enable par "Ended at 20:49 · 2m of Quick today" + chime · sound aur notifications off → kuch nahi baja/dikha, session phir bhi log · Do Not Disturb → banner nahi, list me notification · countdown off → icon running/paused class, label hidden · disable → FocusFlow ka source hata. Shell log me koi JS error nahi. Screenshot: `docs/notification.png`. Asli speaker par chime sunna baaki.

**Notes:**
- **Bug mila:** enable ke turant baad (late finish) history abhi load ho rahi hoti thi, isliye "today" total galat (2m ki jagah 1m) aata tha. Ab sound turant bajta hai, notification `SessionStore.flush()` ke baad banta hai.
- Notification ki apni sound sirf banner dikhne par bajti hai; isliye sound `global.display.get_sound_player()` se khud bajate hain.

---

### Phase 7 — Settings, auto-chain, shortcut, daily goal
**Goal:** Extra features.

- [x] `prefs/settingsPage.js` (naya "Settings" page): sound, notifications, panel countdown, week start (`Adw.ComboRow`)
- [x] **Auto-start (auto-chain):** switch + "After these topics" (checkbox har topic) + "Then start" (`Adw.ComboRow`, "None" + topics); `extension.js` engine ke `finished` par next topic poori length se start karta hai
  - [x] Late finish (suspend / shell restart ke baad pakda gaya) par auto-start **nahi**: wo break waise bhi nikal chuka hota
  - [x] Notification: auto-start hua toh body me "· Break started"; nahi hua toh **Start Break** button
- [x] **Keyboard shortcut:** `Main.wm.addKeybinding('toggle-timer', …, NORMAL | OVERVIEW)` → `engine.toggle()`
  - [x] Running → pause · paused → resume · idle → `last-topic-id` start
  - [x] `disable()` me `Main.wm.removeKeybinding('toggle-timer')`
  - [x] Prefs me `Adw.EntryRow` (`<Super><Alt>p` jaisa text, `Gtk.accelerator_parse` se validate, galat par toast, khali = off) + reset button + "Current shortcut" label (`Alt+Super+P`); asli "keys dabao" capture baad me
- [x] **Daily goal:** topic dialog me `Adw.SpinRow` (0 = koi goal nahi); prefs row subtitle "goal 2h a day"; menu row me naam ke neeche "40m / 2h today", pura hone par hara "✓" (chal raha timer bhi gina)

**Done when:** Har setting restart ke baad bhi rahe aur behaviour sach me badle. Shortcut menu band hone par bhi kaam kare.

**Result (2026-11-02):** Unit tests 58 passed. Prefs harness (Settings + goal) 30/30, Phase 4 harness regression pass. Headless shell (asli time):
Study (1 min, goal 2m) → khud khatam → Break apne aap start (298 s bache), notification "1m of Study today · Break started" · auto-start off → Study khatam, Break nahi chala, notification me "Start Again + Start Break", Start Break dabane par Break chala · goal "0s / 2m" → "3s" → "1m / 2m" → "2m / 2m today ✓" (hara) · virtual keyboard se Super+Alt+P: pause, resume, idle par last topic start · shortcut Ctrl+Shift+F8 kiya → purana ignore, naya kaam kare · disable par binding NONE, re-enable par wapas. Shell log me koi JS error nahi.

**Notes:**
- **Bugs mile aur fix hue:** (1) `Adw.SwitchRow({subtitle: undefined})` GJS me throw karta hai, poora Settings page load nahi hota → default `''`. (2) `settings.bind(…, 'sensitive')` ke saath `NO_SENSITIVITY` flag zaroori, warna bind key ki writability se sensitivity override kar deta hai. (3) `Adw.ComboRow` model badalne par apni `sensitive` khud reset karta hai → auto-start rows ek alag group me, group ki sensitivity bind. (4) Adw group description, row titles aur toasts Pango markup hain: `<Super>` wala help text dikhta hi nahi tha, aur "R&D" jaise topic naam toot jaate → sab user text escape.
- `Main.wm.removeKeybinding()` entry delete nahi karta, mode `NONE` (0) set karta hai.
- dconf se shortcut badalne ke baad naya binding ~1 s me lagta hai (0.5 s wale test me purana abhi active tha).
- **Incident (2 Nov):** mere haath se chalaye headless runs har baar ek `ibus-daemon` chhod dete the jo GBs tak badhta raha; RAM + swap full hokar OOM killer ne VS Code band kiya. Do leaked daemons (1.8 GB + 470 MB, `XDG_RUNTIME_DIR=…/ff-test`) maine band kiye. Ab har headless test `scripts/headless.sh` se (section 4).

---

### Phase 8 — Export / Import
**Goal:** Backup aur restore.

- [x] `prefs/backupPage.js` (naya "Backup" page) + `lib/backup.js` (pure: build/parse, merge, CSV, settings)
- [x] **Export JSON:** `{ app: "focusflow", schemaVersion, exportedAt, topics, settings, sessions }` → `Gtk.FileDialog.save()` → `focusflow-backup-YYYY-MM-DD.json` (settings me sirf user settings, timers jaisi runtime state nahi)
- [x] **Export CSV:** `date,start,end,topic,minutes,completed` (local time, comma/quote wale naam quoted) → `focusflow-history-YYYY-MM-DD.csv`
- [x] **Import JSON:** file choose → `parseBackup()` (app check, `migrate()`, invalid topics/sessions skip + ginti) → preview ("4 topics and 3 sessions, exported …") → **Replace** ya **Merge**
  - [x] Merge: local sab waisa hi; naye id wale topics aage jude (naam takraaye toh "Study (2)"); sessions id se union; local settings waise hi
  - [x] Replace: `clear-timers` request → sessions, topics, settings backup se
- [x] Galat file (JSON nahi / FocusFlow ka nahi / missing) par toast, data me koi badlaav nahi
- [x] **Reset all data**: destructive confirm → `clear-timers`, history khali, settings default, default topics (naye ids)

**Done when:** Export → saara data delete → import karne par sab kuchh pehle jaisa wapas aaye. CSV LibreOffice Calc me sahi khule.

**Result (2026-11-02):** Unit tests 66 passed (IST + New York). Backup page harness (`scripts/headless.sh` ke andar) 14/14: JSON export (4 topics, 3 sessions, settings), CSV export · data badal kar Import → preview · Merge (Local bacha, delete kiya Break wapas same id se, sessions union, settings same; dobara Merge kuchh nahi jodta) · Replace (bilkul backup jaisa) · galat/tooti/missing file reject · Reset confirm, Cancel, Reset (defaults, khali history) · **Reset ke baad backup se sab wapas** (same ids). CSV Python `csv` module se saaf parse hua. Shell test: `clear-timers` ke bina chalte timer ka segment "restored" history me ghus jata (dikhaya), ke saath nahi; extension band hote hue request → enable par handle. Koi leftover process/folder nahi. File chooser dialogs (portal) aur LibreOffice me CSV kholna manual check baaki.

**Notes:**
- **Design:** import/reset bhi prefs se hi hote hain (shell ko file bhejne ki zaroorat nahi), par `clear-timers` request se shell pehle saare timers chhod deta hai; dconf changes order me aate hain, isliye shell ye topics badalne se pehle dekhta hai.
- `SessionStore.transform(fn)`: reload + change + write ek hi queue slot me; `removeTopics()` ab isi par bana.
- Harness `headless.sh` ke andar asli shell (FocusFlow enabled) ke saath chalta hai, isliye `clear-timers` request shell ne sach me handle kiya (pehle test galti se `true` expect kar raha tha).

---

### Phase 9 — Lock screen, suspend, robustness & polish
- [x] Lock screen: engine chalta rahe, indicator hide; lock par finish → notification + sound unlock se pehle bhi
- [x] Suspend/resume: logind `PrepareForSleep(false)` par turant `checkFinished()` (GLib timeouts suspend me nahi chalte); warna bhi 1 s tick wall clock se pakadta; sahi end time ke saath, late = true
- [x] Shell restart / logout-login: running timer sahi remaining time se continue kare *(Phase 2 me verified)*
- [x] `sessions.jsonl` missing, folder, ya kharab lines → extension crash na ho, warning/error log ho
- [x] Bada history (10k+ sessions) → menu kholne par lag na ho: naapa, optimization ki zaroorat nahi (neeche)
- [x] Light/dark theme: default light shell theme aur aapka **ZorinBlue-Dark** dono me readable (`docs/menu-dark.png`)
- [x] `accessible_name`: "Start Study" / "Pause Break" / "Reset Gaming", minutes box "Study: minutes"; Tab se poora menu chalta hai
- [x] Debug logs: koi nahi; module functions par JSDoc comments pehle se

**Done when:** Upar ka har scenario manually check ho chuka ho, aur `journalctl` saaf ho.

**Result (2026-11-02):** Unit tests 66 passed. Sab headless checks `scripts/headless.sh` se, har run ke baad koi leftover process/folder nahi:
- Lock screen (`unlock-dialog` mode): extension ACTIVE, indicator hidden; lock ke dauran timer khatam → chime + "Quick finished" notification; unlock par indicator wapas.
- Suspend jaisa (wall clock end se 10 min aage): ~1 s me finish, "Ended at 21:43 · …", session 60 s, end time sahi (10 min pehle).
- `sessions.jsonl` ki jagah folder → ACTIVE, menu khulta, start/pause chalte (session save fail hokar log hota). Kharab lines → skip, valid 2/2 load.
- Performance (plain gjs): 10k sessions load 21 ms, aggregate 0.3–0.4 ms; 30k 51 ms / ≤0.9 ms; 100k 132 ms / ≤3 ms. Asli shell me 30k ke saath ek poora menu refresh (rows + All-time stats) **1.9 ms**.
- Keyboard: Tab → har topic ka minutes box aur Start button → Manage Topics → Daily/Weekly/Monthly/All → ‹ (disabled buttons skip).
- 10× disable/enable: 1 indicator, 0 bache notification sources, keybinding active.
- ZorinBlue-Dark theme (aapka asli theme) load karke screenshot: text `#bde6fb` dark `#222b30` par, goal hara, deleted topic grey italic — sab readable.
- Poore flow ke baad shell log me 0 JS errors/warnings.

Manual check baaki: asli suspend/resume aur asli screen lock (headless me sirf simulate ho sakta hai).

**Notes:**
- Headless shell hamesha default light theme se chalta hai; dark check ke liye `Main.setThemeStylesheet(<theme css>); Main.loadTheme()` (User Themes extension jaisa).
- `headless.sh` safal run ke baad shell log mita deta hai; log dekhna ho toh command ke andar `$FF_TEST_DIR/shell.log` padho.

---

### Phase 10 — Packaging, testing & release
- [x] `scripts/pack.sh` → `dist/focusflow@rahulrgd.github.io.shell-extension.zip` (28 files, 54 KB: code, prefs, schema, icon, sound, stylesheet; tests/docs/scripts nahi)
- [x] `README.md`: features, screenshots, install, usage, settings, data, lock screen, development (English, background-music-player jaisa)
- [x] `LICENSE` (GPL-2.0, background-music-player jaisa)
- [x] Fresh install test: `gnome-extensions install` temp `XDG_DATA_HOME` me (files + `gschemas.compiled` bane) → us installed copy ko headless shell me chalaya: v1.0.0 ACTIVE, default topics, menu, timer finish (notification + installed `done.oga`), prefs window, 0 JS errors
- [ ] Asli session: `./scripts/install.sh` (ya zip install) → logout/login → enable → neeche wale "Real" column ke checks
- [x] Neeche wale saare test cases headless me pass
- [x] `version-name: "1.0.0"`
- [ ] git tag `v1.0.0` (asli session check ke baad)

#### Test cases

Headless = `scripts/headless.sh` / test harness me verified (phase likha hai). Real = asli Zorin session me haath se.

| #  | Test | Expected | Headless | Real |
|----|------|----------|----------|------|
| 1  | 1-min timer start, menu band, wait | Notification + sound; session `completed: true` | ✅ Ph 2, 6 | [ ] chime suno |
| 2  | Timer chalte hue logout/login | Sahi remaining time se continue | ✅ Ph 2 (disable/enable, restart) | [ ] |
| 3  | Timer chalte hue screen lock | Lock par bhi finish par sound; indicator lock screen par nahi dikhe | ✅ Ph 9 (unlock-dialog mode) | [ ] |
| 4  | Timer chalte hue suspend, phir resume | Overdue timer turant finish, sahi end time | ✅ Ph 9 (wall clock jump) | [ ] |
| 5  | A start, phir B start | A pause + partial session log; B running | ✅ Ph 2, 3 | — |
| 6  | 30 s baad pause, phir reset | 30 s ka partial session; timer idle | ✅ Ph 2, 3 | — |
| 7  | Menu me minutes edit | Save; agle start par lage | ✅ Ph 2, 3 | — |
| 8  | Prefs me drag aur ▲/▼ se reorder | Order save, menu turant update | ✅ Ph 4 (drop handler + ▲▼) | [ ] mouse se drag |
| 9  | History wale topic ko hide | Section 1 se gayab; graph me dikhe | ✅ Ph 3, 4, 5 | — |
| 10 | Delete + keep history | Graph me grey italic naam | ✅ Ph 4, 5 | — |
| 11 | Delete + delete history | Graph se hat jaye | ✅ Ph 4 | — |
| 12 | Daily / Weekly / Monthly / All tabs | Totals raw sessions se match | ✅ Ph 5 | — |
| 13 | ‹ › navigation | Sahi ranges; week start ka dhyan | ✅ Ph 5 (3 timezones) | — |
| 14 | Panel label running / paused / idle | `Study 23:41` / `⏸ …` / sirf icon | ✅ Ph 3, 6 | — |
| 15 | Auto-chain Study → Break | Break khud start ho | ✅ Ph 7 | — |
| 16 | Shortcut, menu band | Pause/resume toggle | ✅ Ph 7 (virtual keyboard) | [ ] asli keyboard |
| 17 | Export → wipe → import | Data same wapas | ✅ Ph 8 | [ ] file chooser |
| 18 | Galat file import | Saaf error, data same | ✅ Ph 8 | — |
| 19 | Light aur dark theme | Dono me readable | ✅ Ph 9 (default + ZorinBlue-Dark) | [ ] |
| 20 | Extension disable/enable 10 baar | Koi leak/duplicate indicator nahi, journal saaf | ✅ Ph 9 | — |

**Asli session ka checklist (aapke liye):**
1. `./scripts/install.sh`, phir logout/login, phir `gnome-extensions enable focusflow@rahulrgd.github.io`
2. Panel me stopwatch icon; menu kholo, ek topic ke minutes `1` karke ▶; menu band karke 1 min ruko → chime + notification
3. Ek timer chalate hue screen lock (`Super+L`), khatam hone do → lock par bhi chime
4. Ek timer chalate hue laptop suspend, timer ke time se zyada baad me kholo → notification "Ended at …"
5. Manage Topics me ek row ko mouse se drag karke dusri jagah chhodo
6. `Super+Alt+P` se pause/resume
7. Backup page: Export → file save dialog; Import → wahi file chuno → Merge
8. `journalctl -b -o cat /usr/bin/gnome-shell | grep -i focusflow` → koi error nahi

## 4. Development & Testing Workflow

### Install (dev mode)
```bash
./scripts/install.sh      # schemas compile + repo ko extensions folder me symlink
```

### Nested Wayland session
Wayland par shell restart (`Alt+F2 → r`) nahi hota, isliye har code change ke baad nested session use karo:
```bash
./scripts/nested.sh
# andar ke terminal se:
gnome-extensions enable focusflow@rahulrgd.github.io
```
Asli session me test karna ho toh logout/login karna padega.

### Logs
```bash
journalctl -f -o cat /usr/bin/gnome-shell     # extension.js ke logs
journalctl -f -o cat /usr/bin/gjs             # prefs.js ke logs
```

### Unit tests (pure modules)
```bash
gjs -m tests/run.js
```

### Data dekhna
```bash
dconf dump /org/gnome/shell/extensions/focusflow/
tail -n 5 ~/.local/share/focusflow/sessions.jsonl
```

### Headless test (bina GUI ke)
**Hamesha `scripts/headless.sh` use karo, haath se `gnome-shell --headless` mat chalao.**
```bash
./scripts/headless.sh                              # gnome-extensions info (State: ACTIVE?)
./scripts/headless.sh --unsafe -- gdbus call --session --dest org.gnome.Shell \
    --object-path /org/gnome/Shell --method org.gnome.Shell.Eval '<js>'
./scripts/headless.sh -- gjs -m my-harness.js      # koi bhi command, test session ke andar
```
Kyun: har haath wale run me gnome-shell ek `ibus-daemon` spawn karta tha jo shell band hone ke baad bhi chalta aur badhta rehta tha. 12 runs ke baad RAM + 24 GB swap full ho gaye aur OOM killer ne VS Code band kar diya (2 Nov 2026). Script ye karti hai:
- poora run apne systemd scope me, `MemoryMax`/`MemorySwapMax` (default 2G, `--mem`) ke saath, toh runaway test sirf khud marta hai
- PATH par no-op `ibus-daemon` stub, toh ibus start hi nahi hota
- exit par scope stop (bacha hua sab kill), document-portal ka FUSE mount unmount, temp dirs delete

Script andar se ye recipe follow karti hai (alag XDG dirs, asli desktop ko chhue bina):
- `XDG_DATA_HOME`/`XDG_CONFIG_HOME` ko temp folders par, phir `dbus-run-session` ke andar `dconf write /org/gnome/shell/enabled-extensions "['focusflow@rahulrgd.github.io']"`. Private bus par chalne wala `dconf-service` temp `XDG_CONFIG_HOME/dconf/user` me likhta hai, asli settings nahi chhuta. (`GSETTINGS_BACKEND=keyfile` mat use karo: do processes ek saath likhein toh ek ka change ud jata hai.)
- `XDG_RUNTIME_DIR` chhota path rakho (jaise `/run/user/1000/ff-test`), kyunki Wayland socket path 108 bytes se lamba nahi ho sakta
- `dbus-run-session -- gnome-shell --headless --wayland --virtual-monitor 1280x720`, phir `gnome-extensions info/enable/disable`
- Shell ke andar JS chalana ho toh `--unsafe-mode` + `org.gnome.Shell.Eval`
- Prefs: GJS harness `prefs.js` ko seedha import karta hai (`GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0`, Extensions gresource register karke), headless shell sirf display ke liye
- Prefs window shell se kholni ho toh: shell start hone se pehle `dbus-update-activation-environment WAYLAND_DISPLAY=`, socket banne ke baad `WAYLAND_DISPLAY=wayland-0`
- Harness me async kaam ho toh sab `main()` me rakho aur `loop.run()` top level par (top-level `await` ke baad nested loop me promises nahi chalte)
- Cleanup me `rm -rf "${DIR:?}"` likho, bare `$DIR` nahi

### Release zip
```bash
./scripts/pack.sh
```

### Useful tools
- Looking Glass: `Alt+F2` → `lg` (shell ke andar JS chala kar objects dekhna)
- `gnome-extensions prefs focusflow@rahulrgd.github.io`
- `gnome-extensions info focusflow@rahulrgd.github.io` (state aur errors)

---

## 5. Risks & Known Limitations

- **Popup menu me text entry:** menu ka keyboard grab kabhi-kabhi `St.Entry` focus me dikkat deta hai. Fallback: minutes ke liye −/+ buttons (5 min step) aur scroll se badalna.
- **Lock screen par chalna:** extension review me `unlock-dialog` ka reason batana padta hai. Indicator hide karna zaroori hai.
- **Prefs aur extension dono `sessions.jsonl` likhte hain:** delete-history ka race Phase 4 me `purge-topic-ids` se khatam kiya. Phase 8: Replace/Reset se pehle `clear-timers` request (shell timers ko bina log kiye hatata hai), Merge `transform()` se (usi queue slot me reload + write). Bacha hua chhota risk: Merge ke reload aur rename ke beech (milliseconds) shell koi session append kare toh wo kho sakta hai.
- **Zorin ka custom panel (Zorin Taskbar):** panel ki position/space alag ho sakti hai. Real session me ek baar dekhna.
- **GNOME version:** sirf Shell 46 target. Zorin future me GNOME upgrade kare toh MessageTray / prefs API check karne padenge.

---

## 6. Open Questions (abhi ke default assumptions)

| Sawal | Default |
|-------|---------|
| Chalte timer ke minutes badle toh? | Agle start par lagega |
| Midnight cross karne wala session? | Start wale din me ginega |
| Weekly view stacked-by-day chahiye? | Abhi nahi (backlog, prefs Stats page) |
| Shortcut default? | `Super+Alt+P` |
| Panel me countdown hamesha? | Haan, setting se band kar sakte hain |

---

## 7. Backlog (future ideas)
- [ ] Prefs me bada Stats page (`Gtk.DrawingArea` + Cairo): stacked-by-day, heatmap calendar, streaks
- [ ] Classic Pomodoro cycle: har N focus sessions ke baad long break
- [ ] Count-up / stopwatch mode
- [ ] Session notes ("kya kaam kiya?")
- [ ] Tags/categories (productive vs leisure) ke hisaab se stats
- [ ] Focus ke dauran Do Not Disturb khud on karna
- [ ] Quick Settings me ek chhota toggle (current timer pause/resume)

---

## Progress Log

| Date       | Phase | Notes |
|------------|-------|-------|
| 2026-11-02 | —     | Plan bana (Chrome version se GNOME Shell extension par switch) |
| 2026-11-02 | 0     | Skeleton: metadata, extension.js, prefs.js, schema (14 keys), icon, scripts. Headless me verified |
| 2026-11-02 | 1     | topicsModel, topicsStore, sessionStore (JSONL), migrate, 28 unit tests. Headless me verified |
| 2026-11-02 | 2     | timerMath + TimerEngine, `active-timer` → `timers` map, destroy() data-loss fix, 45 unit tests. Headless me verified |
| 2026-11-02 | 3     | Panel indicator, timer rows, format.js, stylesheet; menu headless me chala kar + screenshots se verified |
| 2026-11-02 | 4     | Manage Topics page (add/edit/drag/▲▼/hide/delete), purge-topic-ids, 49 unit + 12 prefs checks, headless verified |
| 2026-11-02 | 5     | stats.js + StatsView (tabs, ‹ ›, bars, live), color palette, BinLayout y_expand fix, 57 unit tests (3 TZ), headless verified |
| 2026-11-02 | 6     | Notifier (banner, Start Again, late finish), apna chime, icon-only panel mode, flush() fix, 58 unit tests, headless verified |
| 2026-11-02 | 7     | Settings page, auto-start, Start Break, shortcut, daily goal; 4 prefs bugs fixed; leaked ibus-daemons band kiye, ab `scripts/headless.sh` |
| 2026-11-02 | 8     | Backup page (JSON/CSV export, import Merge/Replace, Reset), lib/backup.js, clear-timers, transform(); 66 unit + 14 harness checks |
| 2026-11-02 | 9     | Resume-from-suspend hook, topic-specific accessible names; lock/suspend/broken-file/perf/keyboard/dark-theme checks headless |
| 2026-11-02 | 10    | README, LICENSE, v1.0.0, zip (28 files); fresh install + headless smoke test of the installed copy; test table filled; real-session checks + tag pending |
