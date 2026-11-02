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
| 5  | Stats & graph (Section 3)                     | ⬜ Not started |       |
| 6  | Notifications, sound & panel label            | ⬜ Not started |       |
| 7  | Settings, auto-chain, shortcut, daily goal    | ⬜ Not started |       |
| 8  | Export / Import                               | ⬜ Not started |       |
| 9  | Lock screen, suspend, robustness & polish     | ⬜ Not started |       |
| 10 | Packaging, testing & release                  | ⬜ Not started |       |

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
│   └── backupPage.js         # export JSON/CSV, import (replace/merge)
├── sounds/
│   └── done.oga
├── docs/
│   ├── menu.png              # README ke liye screenshot (panel menu)
│   └── prefs.png             # README ke liye screenshot (Manage Topics)
├── icons/
│   └── focusflow-symbolic.svg
├── schemas/
│   └── org.gnome.shell.extensions.focusflow.gschema.xml
├── tests/
│   └── run.js                # gjs -m tests/run.js → pure modules ke unit tests
└── scripts/
    ├── install.sh            # schemas compile + ~/.local/share/gnome-shell/extensions me symlink
    ├── nested.sh             # nested Wayland session
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

- [ ] `stats.js` (pure) + unit tests:
  - [ ] `periodRange(type, anchor, weekStart)` → `{ start, end, label }`
  - [ ] `shiftPeriod(type, anchor, ±1)`
  - [ ] `aggregate(sessions, range)` → `[{ topicId, name, color, seconds }]` (zero wale nahi), `totalSeconds`, `completedCount`
- [ ] `statsView.js`:
  - [ ] Tabs: **Daily | Weekly | Monthly | All** (toggle `St.Button`s), last tab `stats-period` me yaad rahe
  - [ ] **‹  label  ›** navigation; current period ke aage `›` disabled
  - [ ] Summary: "Total 5h 20m · 6 completed"
  - [ ] Har topic ki horizontal bar: name · color bar · "2h 15m", sabse zyada time upar
  - [ ] Delete ho chuke topic (history rakhi) → `topicName` + grey color + "(deleted)"
  - [ ] Empty state: "No time logged for this period"
- [ ] Stats sirf tab recompute hon jab menu khule, period badle, ya naya session aaye (har tick par nahi)
- [ ] Chal raha segment bhi (abhi tak ka time) live total me jode (optional, achha lagega)

**Done when:** Aaj, is hafte aur is mahine ke totals `sessions.jsonl` ke raw data se match karein. Pichhle periods par jaana kaam kare. Week start setting ka asar dikhe.

---

### Phase 6 — Notifications, sound & panel label
**Goal:** Timer khatam hone par saaf feedback.

- [ ] `notifier.js`: GNOME 46 API → `new MessageTray.Source({ title: 'FocusFlow', iconName })`, `Main.messageTray.add(source)`, `new MessageTray.Notification({ source, title, body })`
- [ ] Finish par: "Study finished — 45 min logged" (`notifications-enabled` ka dhyan)
- [ ] Notification actions: **Start Break** (agar auto-chain ka break topic set hai) · **Restart**
- [ ] Sound: `sounds/done.oga` play, fallback theme sound `complete` (`sound-enabled` ka dhyan)
- [ ] Panel label: running `Study 23:41` · paused `⏸ Study 12:05` · idle sirf icon; `panel-show-countdown` off ho toh sirf icon + chhota dot
- [ ] Label ki fixed width (tabular numbers) taaki panel hilta na rahe
- [ ] `disable()` par notification source destroy

**Done when:** Menu band ho tab bhi timer khatam hone par notification aaye, sound baje, aur panel label sahi countdown dikhaye. Zorin ka Do Not Disturb on ho toh banner na aaye, par notification list me dikhe.

---

### Phase 7 — Settings, auto-chain, shortcut, daily goal
**Goal:** Extra features.

- [ ] `prefs/settingsPage.js`: sound, notifications, panel countdown, week start (`Adw.ComboRow`)
- [ ] **Auto-chain:** switch + "After" topics (multi-select checkboxes) + "Start" topic (`Adw.ComboRow`); engine ke `finished` signal par hook
- [ ] **Keyboard shortcut:** `Main.wm.addKeybinding('toggle-timer', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, …)`
  - [ ] Running → pause · paused → resume · idle → `last-topic-id` start
  - [ ] `disable()` me `Main.wm.removeKeybinding('toggle-timer')`
  - [ ] Prefs me shortcut badalne ke liye `Adw.EntryRow` (accelerator text, `Gtk.accelerator_parse` se validate); asli "press keys" capture baad me
- [ ] **Daily goal:** topic edit dialog me optional goal (minutes); Section 1 row me "40 / 120 min" + chhoti progress

**Done when:** Har setting restart ke baad bhi rahe aur behaviour sach me badle. Shortcut menu band hone par bhi kaam kare.

---

### Phase 8 — Export / Import
**Goal:** Backup aur restore.

- [ ] `prefs/backupPage.js`
- [ ] **Export JSON:** `{ schemaVersion, exportedAt, topics, settings, sessions }` → `Gtk.FileDialog.save()` → `focusflow-backup-YYYY-MM-DD.json`
- [ ] **Export CSV:** `date, topic, start, end, minutes, completed`
- [ ] **Import JSON:** file choose → shape validate → `migrate()` → preview ("6 topics, 412 sessions") → **Replace** ya **Merge** (`id` se dedupe)
- [ ] Galat file par saaf error, data me koi badlaav nahi
- [ ] (Optional) **Reset all data**, strong confirmation ke saath

**Done when:** Export → saara data delete → import karne par sab kuchh pehle jaisa wapas aaye. CSV LibreOffice Calc me sahi khule.

---

### Phase 9 — Lock screen, suspend, robustness & polish
- [ ] Lock screen: engine chalta rahe, indicator hide; lock par finish → notification + sound unlock se pehle bhi
- [ ] Suspend/resume: resume ke 1 s ke andar overdue timer finish ho, sahi end time ke saath
- [ ] Shell restart / logout-login: running timer sahi remaining time se continue kare
- [ ] `sessions.jsonl` missing ya kharab → extension crash na ho, warning log ho
- [ ] Bada history (10k+ sessions) → menu kholne par lag na ho (cache + sirf zaroori period aggregate)
- [ ] Light/dark theme dono me sahi colors (`stylesheet.css`, topic colors par readable text)
- [ ] Saare buttons ke `accessible_name`, keyboard se menu navigate ho sake
- [ ] Debug logs hatao; har module function par chhota JSDoc comment

**Done when:** Upar ka har scenario manually check ho chuka ho, aur `journalctl` saaf ho.

---

### Phase 10 — Packaging, testing & release
- [ ] `scripts/pack.sh` → `dist/focusflow@rahulrgd.github.io.shell-extension.zip` (`--extra-source` lib, prefs, sounds, icons; `--schema`)
- [ ] `README.md`: features, screenshot, install, shortcut, backup, logs
- [ ] `LICENSE` (GPL-2.0-or-later, background-music-player jaisa)
- [ ] Fresh install test: zip se `gnome-extensions install`, logout/login, enable
- [ ] Neeche wale saare test cases pass
- [ ] `version-name: "1.0.0"`, git tag `v1.0.0`

#### Manual test cases

| #  | Test | Expected | Pass |
|----|------|----------|------|
| 1  | 1-min timer start, menu band, wait | Notification + sound; session `completed: true` | [ ] |
| 2  | Timer chalte hue logout/login | Sahi remaining time se continue | [ ] |
| 3  | Timer chalte hue screen lock | Lock par bhi finish par sound; indicator lock screen par nahi dikhe | [ ] |
| 4  | Timer chalte hue suspend, phir resume | Overdue timer turant finish, sahi end time | [ ] |
| 5  | A start, phir B start | A pause + partial session log; B running | [ ] |
| 6  | 30 s baad pause, phir reset | 30 s ka partial session; timer idle | [ ] |
| 7  | Menu me minutes edit | Save; agle start par lage | [ ] |
| 8  | Prefs me drag aur ▲/▼ se reorder | Order save, menu turant update | [ ] |
| 9  | History wale topic ko hide | Section 1 se gayab; graph me dikhe | [ ] |
| 10 | Delete + keep history | Graph me "(deleted) Name" | [ ] |
| 11 | Delete + delete history | Graph se hat jaye | [ ] |
| 12 | Daily / Weekly / Monthly / All tabs | Totals raw sessions se match | [ ] |
| 13 | ‹ › navigation | Sahi ranges; week start ka dhyan | [ ] |
| 14 | Panel label running / paused / idle | `Study 23:41` / `⏸ …` / sirf icon | [ ] |
| 15 | Auto-chain Study → Break | Break khud start ho | [ ] |
| 16 | Shortcut, menu band | Pause/resume toggle | [ ] |
| 17 | Export → wipe → import | Data same wapas | [ ] |
| 18 | Galat file import | Saaf error, data same | [ ] |
| 19 | Light aur dark theme | Dono me readable | [ ] |
| 20 | Extension disable/enable 10 baar | Koi leak/duplicate indicator nahi, journal saaf | [ ] |

---

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
Asli desktop ko chhue bina, alag XDG dirs ke saath:
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
- **Prefs aur extension dono `sessions.jsonl` likhte hain:** delete-history ka race Phase 4 me `purge-topic-ids` se khatam kiya (purge shell hi karta hai, apni write queue me). Import (Phase 8) abhi bhi prefs se rewrite karega; usi waqt shell append kare toh ek session kho sakta hai. Phase 8 me import bhi shell se karwana ya rewrite se pehle reload karna (`removeTopics` jaisa) decide karna hai.
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
