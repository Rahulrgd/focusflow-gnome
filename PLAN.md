# FocusFlow — Pomodoro / Time-Tracker Chrome Extension — Implementation Plan

> **Target:** Google Chrome on Zorin OS 18 (Linux), loaded unpacked from `chrome://extensions`
> **Stack:** Manifest V3 · plain HTML/CSS/JS (ES modules) · no build step · Chart.js bundled locally
> **Started:** 2026-11-02

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` skipped/deferred

| Phase | Name | Status |
|------:|------|--------|
| 0 | Project setup & skeleton | `[ ]` |
| 1 | Data model & storage layer | `[ ]` |
| 2 | Timer engine (background) | `[ ]` |
| 3 | Popup: Section 1 — Timers | `[ ]` |
| 4 | Manage Topics page (options) | `[ ]` |
| 5 | Stats & graphs (Section 3) | `[ ]` |
| 6 | Notifications, sound & badge | `[ ]` |
| 7 | Settings, auto-chain, shortcut, daily goal | `[ ]` |
| 8 | Export / Import | `[ ]` |
| 9 | Polish, theming & accessibility | `[ ]` |
| 10 | Testing & release checklist | `[ ]` |

---

## Key design decisions (read before coding)

These are settled up front so later phases don't contradict each other.

1. **Single source of truth = `chrome.storage.local`.** The popup and options page are just views: they read state, send commands to the background service worker, and re-render on `chrome.storage.onChanged`.
2. **Timer state is timestamp-based, never tick-based.**
   - Running: `{ topicId, status: "running", startedAt, remainingMsAtStart, durationMs }` → remaining = `remainingMsAtStart - (Date.now() - startedAt)`.
   - Paused: `{ topicId, status: "paused", remainingMs, durationMs }`.
   - The popup uses `requestAnimationFrame`/`setInterval` **only to redraw**, never to track time.
3. **Finish detection uses a one-shot `chrome.alarms` alarm** with `when = finishTime`. Note: Chrome enforces a ~30 s minimum alarm delay, so if under 30 s remain, the popup (if open) finalizes the timer itself when it hits 0. The background also re-checks on service-worker startup (`runtime.onStartup` / first message) and finalizes overdue timers.
4. **Sessions are logged per run segment.** Every time a timer stops running (pause, reset, preempted by another topic, or finish), a session entry is written for the time actually run. Only the segment that reaches 0 gets `completed: true`. This keeps the stats accurate even for paused/abandoned timers.
5. **Sessions spanning midnight** are attributed to the day they started (simple; revisit only if it matters).
6. **Sound in MV3** can't play from a service worker → use an **offscreen document** (`chrome.offscreen`, reason `AUDIO_PLAYBACK`).
7. **Drag-and-drop** uses native HTML5 DnD (no library), with ▲/▼ buttons as a keyboard fallback.
8. **All IDs** are generated with `crypto.randomUUID()`.

### Permissions (manifest)
`storage`, `alarms`, `notifications`, `offscreen` (+ optionally `unlimitedStorage` if history grows large).

### Target file structure
```
focusflow/
├── manifest.json
├── background.js              # service worker: timer engine, alarms, badge, notifications
├── offscreen.html / .js       # plays the finish sound
├── popup.html / .css / .js    # Section 1 (timers), Section 2 (button), Section 3 (stats)
├── options.html / .css / .js  # Manage Topics + Settings + Export/Import
├── modules/
│   ├── storage.js             # read/write helpers, defaults, migrations
│   ├── timer.js               # pure timer math (remaining, finish, segment → session)
│   ├── stats.js               # aggregation by day/week/month, period navigation
│   ├── topics.js              # CRUD + reorder + hide/show
│   └── format.js              # MM:SS, "2h 15m", date labels
├── lib/
│   └── chart.umd.min.js       # Chart.js v4, downloaded locally
├── sounds/
│   └── done.mp3 (or .ogg)
└── icons/
    ├── icon16.png  icon32.png  icon48.png  icon128.png
```

### Data schema (v1)
```js
// chrome.storage.local
{
  schemaVersion: 1,
  topics: [
    { id, name, minutes, color, hidden: false, order: 0, dailyGoalMinutes: null }
  ],
  sessions: [
    { id, topicId, start, end, durationSeconds, completed }   // start/end = epoch ms
  ],
  activeTimer: null | { topicId, status, startedAt, remainingMsAtStart, remainingMs, durationMs },
  settings: {
    sound: true,
    notifications: true,
    weekStart: "mon",          // "mon" | "sun"
    autoChain: { enabled: false, fromTopicIds: [], toTopicId: null }
  }
}
```

---

## Phase 0 — Project setup & skeleton
**Goal:** an extension that loads in Chrome with an empty popup and options page.

- [ ] Create the folder structure above
- [ ] Write `manifest.json` (MV3): `action.default_popup`, `options_page` (open in tab), `background.service_worker` with `"type": "module"`, permissions, icons
- [ ] Add placeholder icons (16/32/48/128 px)
- [ ] Download Chart.js v4 UMD build into `lib/chart.umd.min.js`
  ```bash
  curl -L -o lib/chart.umd.min.js https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js
  ```
- [ ] Stub `popup.html`, `options.html`, `background.js` with a console log each
- [ ] Load unpacked at `chrome://extensions` (Developer mode ON → *Load unpacked* → select folder)

**✅ Done when:** the icon appears in the toolbar, the popup opens, "Inspect service worker" shows the log with no errors.

---

## Phase 1 — Data model & storage layer
**Goal:** reliable, tested read/write of all data in `modules/storage.js` + `modules/topics.js`.

- [ ] `getState()` / `setState(partial)` wrappers over `chrome.storage.local` (async/await)
- [ ] `DEFAULTS` + seeding on `runtime.onInstalled` (reason `install`): Study 45, Break 5, Gaming 30, YouTube 15 — each with a distinct color
- [ ] `schemaVersion` + `migrate(data)` function (no-op for v1, but wired in on `onInstalled` reason `update`)
- [ ] Topic helpers: `addTopic`, `updateTopic`, `deleteTopic(id, { keepHistory })`, `reorderTopics(idsInOrder)`, `toggleHidden(id)`
- [ ] Validation: name non-empty & trimmed, minutes integer 1–600, color valid hex
- [ ] `addSession(session)` helper
- [ ] `subscribe(callback)` helper wrapping `chrome.storage.onChanged`

**✅ Done when:** from the service-worker console you can add/edit/reorder/delete topics and see the stored JSON update correctly; reinstalling seeds defaults; updating does not wipe data.

---

## Phase 2 — Timer engine (background)
**Goal:** a timer that keeps running with the popup closed and survives the service worker sleeping.

- [ ] Pure functions in `modules/timer.js`: `getRemainingMs(timer, now)`, `isFinished(timer, now)`, `segmentToSession(timer, now, completed)`
- [ ] Message API in `background.js` (`runtime.onMessage`): `START(topicId)`, `PAUSE`, `RESUME`, `RESET(topicId)`, `GET_STATE`
- [ ] **START** on a different topic while one is running → pause & log the current one first (only one runs at a time)
- [ ] **START** on a fresh topic → `durationMs = topic.minutes * 60_000`
- [ ] **PAUSE** → log the run segment (`completed: false`), store `remainingMs`, clear alarm
- [ ] **RESET** → log the run segment if running, clear `activeTimer` and alarm
- [ ] Schedule `chrome.alarms.create("timer-finish", { when })` on start/resume
- [ ] `alarms.onAlarm` → finalize: log segment with `completed: true`, clear `activeTimer`, fire `FINISHED` event (hook for Phase 6/7)
- [ ] On service-worker wake (`onStartup`, `onInstalled`, first message): if an overdue running timer exists → finalize it
- [ ] Changing a topic's minutes while it's paused/running: decide & implement (recommended: affects the *next* start only)

**✅ Done when:** start a 1-min timer → close popup → wait → session appears in storage with `completed: true`. Start, pause after 20 s → a 20 s `completed: false` session is logged. Restart Chrome mid-timer → it's finalized correctly.

---

## Phase 3 — Popup: Section 1 (Timers) + Section 2 button
**Goal:** the main UI for running timers.

- [ ] Popup layout: three stacked sections with dividers; fixed width (~360–400 px)
- [ ] Render one row per **visible** topic, sorted by `order`: **Name | minutes input | ▶ ⏸ ↺**
- [ ] Inline minutes `<input type="number" min="1" max="600">` → save on `change`/Enter, with validation
- [ ] Active row: highlighted, live MM:SS countdown, progress bar (redraw every ~250 ms based on timestamps)
- [ ] Button states: Play disabled while running, Pause disabled while paused, etc.; Play on a paused topic = resume
- [ ] Re-render on `storage.onChanged` (so changes from the options page / background show instantly)
- [ ] Empty state: "No visible topics — open Manage Topics"
- [ ] **Section 2:** "⚙ Manage Topics" button → `chrome.runtime.openOptionsPage()`

**✅ Done when:** you can run/pause/reset any topic from the popup; closing and reopening the popup shows the correct remaining time; starting a second topic pauses the first.

---

## Phase 4 — Manage Topics page (options)
**Goal:** full CRUD + ordering of topics in a dedicated tab.

- [ ] Page layout: header, **"+ Add Topic"** button, topic list
- [ ] Add/Edit form (inline row or small modal): name, minutes, color picker (`<input type="color">`)
- [ ] Topic row: **⋮⋮ drag handle | ▲ ▼ | color swatch | Name | minutes | Edit | Hide/Show | Delete**
- [ ] Native HTML5 drag-and-drop reordering → `reorderTopics()`
- [ ] ▲/▼ buttons for keyboard reordering
- [ ] Hide/Show toggle with clear visual state (e.g. dimmed row + "hidden" tag)
- [ ] Delete with an in-page confirmation dialog (not `alert/confirm`) offering **Keep history** / **Delete history**
- [ ] Deleting the currently active topic → reset the timer first
- [ ] Prevent duplicate names (case-insensitive) — warn the user

**✅ Done when:** add, edit, reorder (drag + buttons), hide/show and delete all work and are reflected instantly in an open popup.

---

## Phase 5 — Stats & graphs (Section 3)
**Goal:** bar chart of time per topic for Daily / Weekly / Monthly.

- [ ] `modules/stats.js`:
  - [ ] `getPeriodRange(type, anchorDate, weekStart)` → `{ start, end, label }`
  - [ ] `shiftPeriod(type, anchorDate, ±1)` for Prev/Next
  - [ ] `aggregate(sessions, range)` → `[{ topicId, seconds }]`, total seconds, completed count
- [ ] Tabs: **Daily | Weekly | Monthly | All time**
- [ ] **‹ Prev / label / Next ›** navigation (disable Next beyond the current period)
- [ ] Summary line: total time (e.g. "5h 20m") + completed sessions count
- [ ] Chart.js horizontal or vertical bar chart: one bar per topic with logged time, bar color = topic color, tooltip shows "2h 15m"
- [ ] Deleted topics with kept history → shown as "(deleted) Name" in gray
- [ ] Empty state: "No time logged for this period"
- [ ] Destroy & recreate (or `update()`) the chart when switching tabs to avoid leaks
- [ ] *(Optional)* Weekly stacked-by-day view

**✅ Done when:** charts match the raw session data for today, this week and this month; navigating to past periods works; week start respects the setting.

---

## Phase 6 — Notifications, sound & badge
**Goal:** feedback when timers run and finish.

- [ ] `chrome.notifications.create` on finish: "Study finished — 45 min logged" (respect `settings.notifications`)
- [ ] Clicking the notification → open the popup's stats or just clear it
- [ ] Offscreen document plays `sounds/done.mp3` on finish (respect `settings.sound`); create it on demand, close it after playback
- [ ] Badge: `chrome.action.setBadgeText` with remaining minutes (e.g. "23") + badge color = topic color
- [ ] Badge refresh: periodic alarm (`periodInMinutes: 0.5`) while a timer runs; also update on every state change
- [ ] Paused state badge: "⏸" or "II"; clear the badge when idle
- [ ] Verify Linux/GNOME desktop notifications appear (check Zorin's *Do Not Disturb* if they don't)

**✅ Done when:** finishing a timer with the popup closed shows a desktop notification, plays the sound, and the badge counts down correctly.

---

## Phase 7 — Settings, auto-chain, keyboard shortcut, daily goal
**Goal:** the "extra features" from the spec.

- [ ] Settings panel on the options page: sound on/off, notifications on/off, week start (Mon/Sun)
- [ ] **Auto-chain:** enable toggle + "after [focus topics…] start [break topic]" → hooked into the `FINISHED` event
- [ ] **Keyboard shortcut:** `commands` in manifest, e.g. `toggle-timer` → pause/resume the active (or last-used) timer
  - [ ] Document that shortcuts can be changed at `chrome://extensions/shortcuts`
- [ ] **Daily goal:** optional `dailyGoalMinutes` per topic (in the Add/Edit form); small progress indicator on the popup row (e.g. "40 / 120 min today")

**✅ Done when:** each setting persists across restarts and visibly changes behavior; the shortcut works with the popup closed.

---

## Phase 8 — Export / Import
**Goal:** backups and portability.

- [ ] **Export JSON:** full dump (`schemaVersion`, topics, sessions, settings) → download `pomodoro-backup-YYYY-MM-DD.json`
- [ ] **Export CSV:** sessions with topic name, start, end, duration (min), completed
- [ ] **Import JSON:** file picker → validate shape → run `migrate()` → preview counts → choose **Replace** or **Merge** (dedupe by `id`)
- [ ] Clear error messages for invalid files
- [ ] *(Optional)* "Reset all data" with a strong confirmation

**✅ Done when:** export → delete all data → import restores everything identically; the CSV opens correctly in LibreOffice Calc.

---

## Phase 9 — Polish, theming & accessibility
- [ ] CSS variables for colors; `prefers-color-scheme` light/dark
- [ ] Consistent spacing, rounded cards, readable fonts; check popup doesn't overflow
- [ ] All buttons have `aria-label`/`title`; visible focus outlines; full keyboard navigation
- [ ] Final icons (a tomato/clock design) at all sizes
- [ ] Remove debug logs; add short JSDoc comments to every module function
- [ ] `README.md`: features, install steps, shortcut, backup instructions

**✅ Done when:** looks right in both light and dark mode, and everything is usable with keyboard only.

---

## Phase 10 — Testing & release checklist

### Manual test cases
| # | Test | Expected | Pass |
|---|------|----------|------|
| 1 | Start 1-min timer, close popup, wait | Notification + sound; session `completed: true` | [ ] |
| 2 | Start timer, restart Chrome before it ends | Timer continues / finalizes correctly after restart | [ ] |
| 3 | Start A, then start B | A paused + partial session logged; B running | [ ] |
| 4 | Pause after 30 s, then reset | 30 s partial session logged; timer idle | [ ] |
| 5 | Edit minutes inline in popup | Saved; used on next start | [ ] |
| 6 | Reorder topics via drag and via ▲/▼ | Order persists and shows in popup | [ ] |
| 7 | Hide a topic with history | Gone from Section 1; still in graphs | [ ] |
| 8 | Delete topic, keep history | Shows as "(deleted)" in graphs | [ ] |
| 9 | Delete topic, delete history | Removed from graphs | [ ] |
| 10 | Daily / Weekly / Monthly / All time tabs | Totals match raw sessions | [ ] |
| 11 | Prev/Next period navigation | Correct ranges; week start respected | [ ] |
| 12 | Badge while running / paused / idle | Minutes / pause sign / empty | [ ] |
| 13 | Auto-chain Study → Break | Break starts automatically | [ ] |
| 14 | Keyboard shortcut with popup closed | Toggles pause/resume | [ ] |
| 15 | Export JSON → wipe → import | Data restored identically | [ ] |
| 16 | Import an invalid file | Friendly error, no data change | [ ] |
| 17 | Light & dark system theme | Both readable | [ ] |
| 18 | Extension reload (update) | No data loss; migration runs | [ ] |

### Release
- [ ] All tests above pass
- [ ] No errors in service-worker, popup and options consoles
- [ ] Version bumped in `manifest.json`
- [ ] Backup exported before any future upgrade

---

## Future ideas (backlog)
- [ ] Sync across devices via `chrome.storage.sync` (topics/settings only, sessions too large)
- [ ] Long-break after every N focus sessions (classic Pomodoro cycle)
- [ ] Streaks & heatmap calendar view
- [ ] Tags/categories (e.g. "productive" vs "leisure") with grouped stats
- [ ] Count-up / stopwatch mode for open-ended tasks
- [ ] Session notes ("what did I work on?")
- [ ] Website blocking during focus topics (`declarativeNetRequest`)
- [ ] Companion GNOME Shell extension showing the active timer in the top panel

---

## Progress log
| Date | Phase | Notes |
|------|-------|-------|
| 2026-11-02 | — | Plan created |
