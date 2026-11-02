// Unit tests for the modules that don't need a running shell.
// Run from the repo root: glib-compile-schemas schemas && gjs -m tests/run.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {exit} from 'system';

import {formatClock, formatDuration} from '../lib/format.js';
import * as Model from '../lib/topicsModel.js';
import {migrateData, migrateSettings, SCHEMA_VERSION} from '../lib/migrate.js';
import {isValidSession, parseSessionLines, SessionStore} from '../lib/sessionStore.js';
import {TimerEngine} from '../lib/timerEngine.js';
import * as TimerMath from '../lib/timerMath.js';
import {TopicsStore} from '../lib/topicsStore.js';

const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function assert(ok, message = 'assertion failed') {
    if (!ok)
        throw new Error(message);
}

function eq(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message} expected ${e}, got ${a}`.trim());
}

function throws(fn, pattern) {
    try {
        fn();
    } catch (e) {
        if (pattern && !pattern.test(e.message))
            throw new Error(`threw "${e.message}", expected ${pattern}`);
        return;
    }
    throw new Error('expected an exception');
}

async function rejects(promise, pattern) {
    try {
        await promise;
    } catch (e) {
        if (pattern && !pattern.test(e.message))
            throw new Error(`rejected with "${e.message}", expected ${pattern}`);
        return;
    }
    throw new Error('expected a rejection');
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(cond, timeoutMs = 5000) {
    for (let t = 0; t < timeoutMs; t += 50) {
        if (cond())
            return;
        await sleep(50);
    }
    throw new Error('timed out waiting for condition');
}

let idCounter = 0;
const nextId = () => `id${++idCounter}`;
const names = topics => Model.sortTopics(topics).map(t => t.name);
const seeded = () => Model.seedTopics(nextId);

function memorySettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        `${ROOT}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
    return new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.focusflow', false),
        backend: Gio.memory_settings_backend_new(),
    });
}

function session(n, fields = {}) {
    return {
        id: `s${n}`, topicId: 't1', topicName: 'Study',
        start: 1_000_000 * n, end: 1_000_000 * n + 60_000, seconds: 60, completed: true,
        ...fields,
    };
}

let tmpDir = null;
function tmpPath(name) {
    tmpDir ??= GLib.dir_make_tmp('focusflow-test-XXXXXX');
    return GLib.build_filenamev([tmpDir, name]);
}

// ---- topicsModel ----

test('seedTopics: 4 defaults with order 0..3 and unique ids', () => {
    const list = seeded();
    eq(names(list), ['Study', 'Break', 'Gaming', 'YouTube']);
    eq(list.map(t => t.order), [0, 1, 2, 3]);
    eq(new Set(list.map(t => t.id)).size, 4);
    eq(list.map(t => t.minutes), [45, 5, 30, 15]);
    assert(list.every(t => t.hidden === false && t.dailyGoalMinutes === null));
});

test('addTopic: trims name, lowercases color, appends at the end', () => {
    const list = Model.addTopic(seeded(), {name: '  Reading ', minutes: '20', color: '#ABCDEF'}, 'r');
    const t = Model.findTopic(list, 'r');
    eq([t.name, t.minutes, t.color, t.order], ['Reading', 20, '#abcdef', 4]);
});

test('addTopic: rejects empty, too long and duplicate names', () => {
    const list = seeded();
    throws(() => Model.addTopic(list, {name: '   ', minutes: 5}, 'x'), /Name is required/);
    throws(() => Model.addTopic(list, {name: 'x'.repeat(41), minutes: 5}, 'x'), /at most 40/);
    throws(() => Model.addTopic(list, {name: 'study', minutes: 5}, 'x'), /already exists/);
});

test('addTopic: rejects bad minutes, color and daily goal', () => {
    const list = seeded();
    for (const minutes of [0, 601, 2.5, 'abc', -5])
        throws(() => Model.addTopic(list, {name: 'A', minutes}, 'x'), /Minutes/);
    for (const color of ['red', '#fff', '#12345g', ''])
        throws(() => Model.addTopic(list, {name: 'A', minutes: 5, color}, 'x'), /Color/);
    throws(() => Model.addTopic(list, {name: 'A', minutes: 5, dailyGoalMinutes: 1441}, 'x'), /Daily goal/);
    eq(Model.addTopic(list, {name: 'A', minutes: 5, dailyGoalMinutes: ''}, 'x').at(-1).dailyGoalMinutes, null);
    eq(Model.addTopic(list, {name: 'A', minutes: 5, dailyGoalMinutes: '90'}, 'x').at(-1).dailyGoalMinutes, 90);
});

test('addTopic: first topic of an empty list gets order 0', () => {
    eq(Model.addTopic([], {name: 'A', minutes: 5}, 'a')[0].order, 0);
});

test('updateTopic: keeps id, allows case change of own name, rejects clash', () => {
    const list = seeded();
    const study = list[0];
    const renamed = Model.updateTopic(list, study.id, {name: 'STUDY', minutes: 50});
    eq([Model.findTopic(renamed, study.id).name, Model.findTopic(renamed, study.id).minutes], ['STUDY', 50]);
    throws(() => Model.updateTopic(list, study.id, {name: 'break'}), /already exists/);
    throws(() => Model.updateTopic(list, 'nope', {minutes: 5}), /No topic/);
});

test('functions never mutate their input', () => {
    const list = seeded();
    const before = JSON.stringify(list);
    Model.addTopic(list, {name: 'A', minutes: 5}, 'a');
    Model.updateTopic(list, list[0].id, {minutes: 10});
    Model.deleteTopic(list, list[0].id);
    Model.toggleHidden(list, list[0].id);
    Model.reorderTopics(list, [list[3].id]);
    Model.moveTopic(list, list[0].id, 1);
    eq(JSON.stringify(list), before);
});

test('deleteTopic: removes and renumbers', () => {
    const list = seeded();
    const out = Model.deleteTopic(list, list[1].id);
    eq(names(out), ['Study', 'Gaming', 'YouTube']);
    eq(Model.sortTopics(out).map(t => t.order), [0, 1, 2]);
});

test('visibleTopics excludes hidden topics, in order', () => {
    let list = seeded();
    list = Model.toggleHidden(list, list[2].id);
    eq(Model.visibleTopics(list).map(t => t.name), ['Study', 'Break', 'YouTube']);
    list = Model.toggleHidden(list, list[2].id);
    eq(Model.visibleTopics(list).length, 4);
});

test('reorderTopics: full, partial and unknown ids', () => {
    const list = seeded();
    const [s, b, g, y] = list.map(t => t.id);
    eq(names(Model.reorderTopics(list, [y, g, b, s])), ['YouTube', 'Gaming', 'Break', 'Study']);
    eq(names(Model.reorderTopics(list, [g, 'ghost'])), ['Gaming', 'Study', 'Break', 'YouTube']);
    eq(Model.reorderTopics(list, [y, g, b, s]).map(t => t.order).sort(), [0, 1, 2, 3]);
});

test('moveTopic: up, down and clamped at the ends', () => {
    const list = seeded();
    const [s, , , y] = list.map(t => t.id);
    eq(names(Model.moveTopic(list, s, 1)), ['Break', 'Study', 'Gaming', 'YouTube']);
    eq(names(Model.moveTopic(list, y, -1)), ['Study', 'Break', 'YouTube', 'Gaming']);
    eq(names(Model.moveTopic(list, s, -1)), ['Study', 'Break', 'Gaming', 'YouTube']);
    eq(names(Model.moveTopic(list, y, 5)), ['Study', 'Break', 'Gaming', 'YouTube']);
    throws(() => Model.moveTopic(list, 'nope', 1), /No topic/);
});

test('parseTopics: bad JSON and non-arrays give []', () => {
    eq(Model.parseTopics('{oops'), []);
    eq(Model.parseTopics('{"a":1}'), []);
    eq(Model.parseTopics(''), []);
});

test('parseTopics: drops invalid entries, fills defaults, renumbers', () => {
    const json = JSON.stringify([
        {id: 'b', name: 'B', minutes: 5, color: '#000000', order: 7},
        null,
        {id: 'x', name: '', minutes: 5, color: '#000000'},
        {name: 'NoId', minutes: 5, color: '#000000'},
        {id: 'a', name: 'A', minutes: 5, color: '#000000', order: 2},
        {id: 'dup', name: 'a', minutes: 5, color: '#000000'},
    ]);
    const list = Model.parseTopics(json);
    eq(list.map(t => [t.id, t.order, t.hidden, t.dailyGoalMinutes]),
        [['a', 0, false, null], ['b', 1, false, null]]);
});

test('parseTopics round-trips a valid list', () => {
    const list = seeded();
    eq(Model.parseTopics(JSON.stringify(list)), list);
});

// ---- migrate ----

test('migrateData: current version is a no-op, missing version means v1', () => {
    eq(migrateData({schemaVersion: 1, topics: []}), {schemaVersion: SCHEMA_VERSION, topics: []});
    eq(migrateData({topics: []}).schemaVersion, SCHEMA_VERSION);
});

test('migrateData: rejects newer and invalid versions', () => {
    throws(() => migrateData({schemaVersion: SCHEMA_VERSION + 1}), /newer FocusFlow/);
    throws(() => migrateData({schemaVersion: 0}), /Invalid schema version/);
    throws(() => migrateData({schemaVersion: '1'}), /Invalid schema version/);
});

test('migrateSettings: current version passes, newer version is refused', () => {
    const settings = memorySettings();
    assert(migrateSettings(settings));
    settings.set_int('schema-version', SCHEMA_VERSION + 1);
    print('     (an expected "newer FocusFlow" error is logged below)');
    assert(!migrateSettings(settings), 'newer data should not migrate');
    eq(settings.get_int('schema-version'), SCHEMA_VERSION + 1, 'version left untouched');
});

// ---- TopicsStore (GSettings, memory backend) ----

test('TopicsStore.seedIfNeeded: seeds once, never re-adds after deletes', () => {
    const settings = memorySettings();
    const store = new TopicsStore(settings);
    assert(store.seedIfNeeded());
    eq(store.sorted.map(t => t.name), ['Study', 'Break', 'Gaming', 'YouTube']);
    assert(!store.seedIfNeeded());
    for (const t of store.all)
        store.delete(t.id);
    assert(!store.seedIfNeeded());
    eq(store.all, []);
});

test('TopicsStore.seedIfNeeded: keeps existing topics', () => {
    const settings = memorySettings();
    settings.set_string('topics', JSON.stringify([{id: 'k', name: 'Kept', minutes: 9, color: '#111111', order: 0}]));
    const store = new TopicsStore(settings);
    assert(store.seedIfNeeded());
    eq(store.all.map(t => t.name), ['Kept']);
});

test('TopicsStore: writes persist as JSON and fire changed', () => {
    const settings = memorySettings();
    const store = new TopicsStore(settings);
    store.seedIfNeeded();
    let calls = 0;
    let last = null;
    const id = store.connectChanged(list => {
        calls++;
        last = list;
    });
    const r = store.add({name: 'Reading', minutes: 20});
    store.update(r.id, {minutes: 25});
    store.toggleHidden(r.id);
    store.move(r.id, -10);
    store.disconnect(id);
    store.delete(r.id);
    eq(calls, 4);
    eq(last[0].name, 'Reading');
    const stored = JSON.parse(settings.get_string('topics'));
    eq(stored.map(t => t.name), ['Study', 'Break', 'Gaming', 'YouTube']);
    throws(() => store.add({name: 'study', minutes: 5}), /already exists/);
    eq(store.visible.length, 4);
});

// ---- sessions ----

test('isValidSession', () => {
    assert(isValidSession(session(1)));
    assert(!isValidSession(null));
    assert(!isValidSession(session(1, {id: ''})));
    assert(!isValidSession(session(1, {end: 0})));
    assert(!isValidSession(session(1, {seconds: -1})));
    assert(!isValidSession(session(1, {completed: 'yes'})));
    assert(!isValidSession(session(1, {topicName: undefined})));
});

test('parseSessionLines: skips blank and malformed lines', () => {
    const text = `${JSON.stringify(session(1))}\n\n{broken\n${JSON.stringify({a: 1})}\n${JSON.stringify(session(2))}`;
    const {sessions, skipped} = parseSessionLines(text);
    eq(sessions.map(s => s.id), ['s1', 's2']);
    eq(skipped, 2);
});

test('SessionStore: missing file loads as empty, dir is created on append', async () => {
    const path = tmpPath('nested/dir/sessions.jsonl');
    const store = new SessionStore(path);
    await store.load();
    eq(store.sessions, []);
    await store.append(session(1));
    await store.append(session(2));
    eq(store.sessions.map(s => s.id), ['s1', 's2']);
    const [, contents] = GLib.file_get_contents(path);
    eq(new TextDecoder().decode(contents).split('\n'), [JSON.stringify(session(1)), JSON.stringify(session(2)), '']);
    const again = new SessionStore(path);
    await again.load();
    eq(again.sessions, store.sessions);
    store.destroy();
    again.destroy();
});

test('SessionStore: invalid sessions are rejected and not written', async () => {
    const path = tmpPath('invalid.jsonl');
    const store = new SessionStore(path);
    await rejects(store.append(session(1, {seconds: -1})), /Invalid session/);
    await rejects(store.rewrite([session(1), {}]), /Invalid session/);
    assert(!GLib.file_test(path, GLib.FileTest.EXISTS));
    store.destroy();
});

test('SessionStore: 50 concurrent appends all land intact', async () => {
    const path = tmpPath('concurrent.jsonl');
    const store = new SessionStore(path);
    await Promise.all(Array.from({length: 50}, (_, i) => store.append(session(i))));
    const reread = new SessionStore(path);
    await reread.load();
    eq(reread.sessions.length, 50);
    eq(reread.sessions.map(s => s.id), Array.from({length: 50}, (_, i) => `s${i}`));
    store.destroy();
    reread.destroy();
});

test('SessionStore: rewrite replaces contents; corrupt lines skipped on load', async () => {
    const path = tmpPath('rewrite.jsonl');
    const store = new SessionStore(path);
    for (let i = 0; i < 3; i++)
        await store.append(session(i));
    await store.rewrite(store.sessions.filter(s => s.id !== 's1'));
    eq(store.sessions.map(s => s.id), ['s0', 's2']);
    GLib.file_set_contents(path, `${JSON.stringify(session(7))}\nnot json\n`);
    print('     (an expected "skipped 1 malformed line" warning is logged below)');
    await store.load();
    eq(store.sessions.map(s => s.id), ['s7']);
    store.destroy();
});

test('SessionStore: connectChanged fires on load/append/rewrite, not after disconnect', async () => {
    const store = new SessionStore(tmpPath('callbacks.jsonl'));
    const seen = [];
    const id = store.connectChanged(list => seen.push(list.length));
    await store.load();
    await store.append(session(1));
    await store.rewrite([]);
    store.disconnect(id);
    await store.append(session(2));
    eq(seen, [0, 1, 0]);
    store.destroy();
});

test('SessionStore.destroy: queued writes still land', async () => {
    const path = tmpPath('destroy.jsonl');
    const store = new SessionStore(path);
    const pending = [store.append(session(1)), store.append(session(2))];
    store.destroy();
    await Promise.all(pending);
    const reread = new SessionStore(path);
    await reread.load();
    eq(reread.sessions.map(s => s.id), ['s1', 's2']);
    reread.destroy();
});

test('SessionStore.removeTopics: drops only those topics, keeps outside writes', async () => {
    const path = tmpPath('remove.jsonl');
    const store = new SessionStore(path);
    await store.append(session(1, {topicId: 'a'}));
    await store.append(session(2, {topicId: 'b'}));
    // Written by another process after our last load.
    const other = new SessionStore(path);
    await other.append(session(3, {topicId: 'a'}));
    await other.append(session(4, {topicId: 'c'}));
    await store.removeTopics(['a', 'ghost']);
    eq(store.sessions.map(s => s.id), ['s2', 's4']);
    const reread = new SessionStore(path);
    await reread.load();
    eq(reread.sessions.map(s => s.id), ['s2', 's4']);
    await store.removeTopics(['nothing']);
    eq(store.sessions.map(s => s.id), ['s2', 's4']);
    [store, other, reread].forEach(s => s.destroy());
});

test('SessionStore.monitor: reloads on external change, ignores own writes', async () => {
    const path = tmpPath('monitor.jsonl');
    const store = new SessionStore(path);
    await store.load();
    store.monitor();
    let loads = 0;
    store.connectChanged(() => loads++);
    await store.append(session(1));
    await sleep(1500);
    eq(loads, 1, 'own append should notify exactly once');

    // Another process (prefs) rewrites the file via temp + rename.
    const other = new SessionStore(path);
    await other.rewrite([session(5), session(6)]);
    await waitFor(() => store.sessions.length === 2);
    eq(store.sessions.map(s => s.id), ['s5', 's6']);
    other.destroy();
    store.destroy();
});

// ---- timerMath ----

const T0 = 1_762_000_000_000;
const MIN = 60_000;
const study = {id: 'study', name: 'Study', minutes: 45};

test('timerMath: start, remaining, progress, finishAt', () => {
    const t = TimerMath.startTimer(study, T0);
    eq([t.status, t.durationMs, t.remainingMsAtStart, t.topicName], ['running', 45 * MIN, 45 * MIN, 'Study']);
    eq(TimerMath.remainingMs(t, T0 + 15 * MIN), 30 * MIN);
    assert(Math.abs(TimerMath.progress(t, T0 + 15 * MIN) - 1 / 3) < 1e-9, 'progress 1/3');
    eq(TimerMath.finishAt(t), T0 + 45 * MIN);
    assert(!TimerMath.isFinished(t, T0 + 45 * MIN - 1));
    assert(TimerMath.isFinished(t, T0 + 45 * MIN));
    eq(TimerMath.remainingMs(t, T0 + 99 * MIN), 0);
});

test('timerMath: pause/resume keep remaining; gap and backwards clock add nothing', () => {
    const t = TimerMath.startTimer(study, T0);
    const p = TimerMath.pauseTimer(t, T0 + 10 * MIN);
    eq([p.status, p.remainingMs, p.pausedAt, 'startedAt' in p], ['paused', 35 * MIN, T0 + 10 * MIN, false]);
    eq(TimerMath.remainingMs(p, T0 + 500 * MIN), 35 * MIN);
    eq(TimerMath.finishAt(p), null);
    const r = TimerMath.resumeTimer(p, T0 + 60 * MIN);
    eq([r.status, r.remainingMsAtStart, 'pausedAt' in r], ['running', 35 * MIN, false]);
    eq(TimerMath.remainingMs(r, T0 + 50 * MIN), 35 * MIN, 'clock moved backwards');
});

test('timerMath.segmentToSession: partial, completed, too short, paused', () => {
    const t = TimerMath.startTimer(study, T0);
    eq(TimerMath.segmentToSession(t, T0 + 20_000, false, 'a'),
        {id: 'a', topicId: 'study', topicName: 'Study', start: T0, end: T0 + 20_000, seconds: 20, completed: false});
    const done = TimerMath.segmentToSession(t, T0 + 90 * MIN, true, 'b');
    eq([done.end, done.seconds, done.completed], [T0 + 45 * MIN, 2700, true]);
    eq(TimerMath.segmentToSession(t, T0 + 400, false, 'c'), null);
    eq(TimerMath.segmentToSession(t, T0 - 5000, false, 'd'), null);
    eq(TimerMath.segmentToSession(TimerMath.pauseTimer(t, T0 + MIN), T0 + 2 * MIN, false, 'e'), null);
});

test('timerMath.parseTimers: drops malformed entries, keeps one running', () => {
    eq(TimerMath.parseTimers('nope'), {});
    eq(TimerMath.parseTimers('[]'), {});
    const a = TimerMath.startTimer({id: 'a', name: 'A', minutes: 10}, T0);
    const b = TimerMath.startTimer({id: 'b', name: 'B', minutes: 10}, T0 + MIN);
    const c = TimerMath.pauseTimer(TimerMath.startTimer({id: 'c', name: 'C', minutes: 10}, T0), T0 + 2 * MIN);
    const parsed = TimerMath.parseTimers(JSON.stringify({
        a, b, c, wrong: a, bad: {topicId: 'bad', status: 'running'},
    }));
    eq(Object.keys(parsed).sort(), ['a', 'b', 'c']);
    eq(TimerMath.runningTimer(parsed).topicId, 'b');
    eq([parsed.a.status, parsed.a.remainingMs], ['paused', 9 * MIN]);
    eq(TimerMath.lastPausedTimer(parsed).topicId, 'c');
});

// ---- TimerEngine ----

function makeEngine(name, {settings = memorySettings(), path = tmpPath(`${name}.jsonl`), clock} = {}) {
    const topics = new TopicsStore(settings);
    topics.seedIfNeeded();
    const sessions = new SessionStore(path);
    const time = clock ?? {now: T0};
    const engine = new TimerEngine({settings, topics, sessions, now: () => time.now});
    const finished = [];
    engine.connect('finished', (_e, session, late) => finished.push({session, late}));
    const id = n => topics.all.find(t => t.name === n).id;
    // load() is queued behind pending appends, so it also waits for them.
    const logged = async () => (await sessions.load(), sessions.sessions);
    const done = () => {
        engine.destroy();
        sessions.destroy();
    };
    return {settings, topics, sessions, engine, time, finished, id, logged, done};
}

test('engine: start runs a topic and persists it', async () => {
    const h = makeEngine('start');
    let changes = 0;
    h.engine.connect('changed', () => changes++);
    h.engine.start(h.id('Study'));
    eq(h.engine.running.topicId, h.id('Study'));
    eq(h.engine.remainingMs(h.id('Study')), 45 * MIN);
    eq(h.settings.get_string('last-topic-id'), h.id('Study'));
    eq(Object.keys(JSON.parse(h.settings.get_string('timers'))), [h.id('Study')]);
    eq(changes, 1);
    throws(() => h.engine.start('ghost'), /No topic/);
    h.done();
});

test('engine: pause logs the run; resume skips the paused gap', async () => {
    const h = makeEngine('pause');
    const s = h.id('Study');
    h.engine.start(s);
    h.time.now += 20_000;
    h.engine.pause();
    eq(h.engine.getTimer(s).status, 'paused');
    eq(h.engine.remainingMs(s), 45 * MIN - 20_000);
    h.time.now += 100 * MIN;
    h.engine.start(s);
    h.time.now += 10_000;
    h.engine.pause(s);
    eq(h.engine.remainingMs(s), 45 * MIN - 30_000);
    eq((await h.logged()).map(x => [x.seconds, x.completed]), [[20, false], [10, false]]);
    h.done();
});

test('engine: starting another topic pauses the current one; each keeps progress', async () => {
    const h = makeEngine('switch');
    const [s, b] = [h.id('Study'), h.id('Break')];
    h.engine.start(s);
    h.time.now += 5 * MIN;
    h.engine.start(b);
    eq([h.engine.getTimer(s).status, h.engine.running.topicId], ['paused', b]);
    h.time.now += MIN;
    h.engine.start(s);
    eq([h.engine.getTimer(b).status, h.engine.running.topicId], ['paused', s]);
    eq(h.engine.remainingMs(s), 40 * MIN);
    eq(h.engine.remainingMs(b), 4 * MIN);
    h.engine.start(s);
    eq(h.engine.remainingMs(s), 40 * MIN, 'start on the running topic is a no-op');
    eq((await h.logged()).map(x => [x.topicName, x.seconds]), [['Study', 300], ['Break', 60]]);
    h.done();
});

test('engine: reset logs a running segment, not a paused one', async () => {
    const h = makeEngine('reset');
    const [s, b] = [h.id('Study'), h.id('Break')];
    h.engine.start(s);
    h.time.now += 30_000;
    h.engine.reset(s);
    eq(h.engine.getTimer(s), null);
    h.engine.start(b);
    h.time.now += 30_000;
    h.engine.pause();
    h.engine.reset(b);
    h.engine.reset('nothing-here');
    eq(h.engine.timers, {});
    eq((await h.logged()).map(x => [x.topicName, x.seconds]), [['Study', 30], ['Break', 30]]);
    h.done();
});

test('engine: finish is logged at the exact end time, even if noticed late', async () => {
    const h = makeEngine('finish');
    const b = h.id('Break');
    h.engine.start(b);
    h.time.now += 5 * MIN + 500;
    assert(h.engine.checkFinished());
    eq(h.engine.timers, {});
    eq(h.finished.length, 1);
    eq([h.finished[0].session.end, h.finished[0].session.completed, h.finished[0].late], [T0 + 5 * MIN, true, false]);
    h.engine.start(b);
    h.time.now += 60 * MIN;
    h.engine.pause();
    eq(h.engine.timers, {}, 'pause after the end finishes instead');
    eq(h.finished[1].late, true);
    eq((await h.logged()).map(x => [x.seconds, x.completed]), [[300, true], [300, true]]);
    eq(h.settings.get_string('last-topic-id'), b);
    h.done();
});

test('engine: state survives a restart (disable/enable, logout)', async () => {
    const settings = memorySettings();
    const clock = {now: T0};
    const path = tmpPath('restart.jsonl');
    const first = makeEngine('restart', {settings, clock, path});
    const [s, g] = [first.id('Study'), first.id('Gaming')];
    first.engine.start(g);
    clock.now += 10 * MIN;
    first.engine.start(s);
    first.done();

    clock.now += 20 * MIN;
    const second = makeEngine('restart', {settings, clock, path});
    eq(second.engine.running.topicId, s);
    eq(second.engine.remainingMs(s), 25 * MIN);
    eq(second.engine.remainingMs(g), 20 * MIN);
    assert(!second.engine.checkFinished());
    second.done();

    clock.now += 60 * MIN;
    const third = makeEngine('restart', {settings, clock, path});
    assert(third.engine.checkFinished());
    eq([third.finished[0].session.end, third.finished[0].late], [T0 + 10 * MIN + 45 * MIN, true]);
    eq(Object.keys(third.engine.timers), [g]);
    eq((await third.logged()).map(x => [x.topicName, x.seconds, x.completed]),
        [['Gaming', 600, false], ['Study', 2700, true]]);
    third.done();
});

test('engine: deleting a topic drops its timer (running segment logged)', async () => {
    const h = makeEngine('delete');
    const [s, b] = [h.id('Study'), h.id('Break')];
    h.engine.start(b);
    h.time.now += MIN;
    h.engine.start(s);
    h.time.now += 2 * MIN;
    h.topics.delete(s);
    h.topics.delete(b);
    eq(h.engine.timers, {});
    eq((await h.logged()).map(x => [x.topicName, x.seconds]), [['Break', 60], ['Study', 120]]);
    h.done();
});

test('engine: editing minutes only affects the next start', () => {
    const h = makeEngine('minutes');
    const s = h.id('Study');
    h.engine.start(s);
    h.topics.update(s, {minutes: 10});
    eq(h.engine.remainingMs(s), 45 * MIN);
    h.engine.reset(s);
    h.engine.start(s);
    eq(h.engine.remainingMs(s), 10 * MIN);
    h.done();
});

test('engine.forget: drops a running timer without logging it', async () => {
    const h = makeEngine('forget');
    const s = h.id('Study');
    h.engine.start(s);
    h.time.now += 5 * MIN;
    h.engine.forget(s);
    h.engine.forget('ghost');
    eq(h.engine.timers, {});
    eq(h.engine._tickId, 0);
    h.topics.delete(s);
    eq(await h.logged(), []);
    h.done();
});

test('engine.toggle: pause, resume last paused, else last topic, else first visible', () => {
    const h = makeEngine('toggle');
    const [s, b, g] = [h.id('Study'), h.id('Break'), h.id('Gaming')];
    h.engine.toggle();
    eq(h.engine.running.topicId, s, 'idle with no history starts the first visible topic');
    h.engine.reset(s);
    h.settings.set_string('last-topic-id', g);
    h.engine.toggle();
    eq(h.engine.running.topicId, g, 'idle starts the last used topic');
    h.engine.toggle();
    eq(h.engine.running, null, 'running gets paused');
    h.time.now += MIN;
    h.engine.start(b);
    h.engine.toggle();
    h.engine.toggle();
    eq(h.engine.running.topicId, b, 'resumes the most recently paused');
    h.done();
});

test('engine tick: finishes on the real main loop and stops ticking', async () => {
    const h = makeEngine('tick');
    let ticks = 0;
    h.engine.connect('tick', () => ticks++);
    h.engine.start(h.id('Break'));
    await sleep(1100);
    assert(ticks >= 1, 'ticked while running');
    h.time.now += 5 * MIN;
    await waitFor(() => h.finished.length === 1, 3000);
    eq(h.engine._tickId, 0);
    h.done();
});

test('engine tick: a finished handler can start the next timer (auto-chain)', async () => {
    const h = makeEngine('chain');
    const [s, b] = [h.id('Study'), h.id('Break')];
    h.engine.connect('finished', () => h.engine.start(b));
    h.engine.start(s);
    h.time.now += 45 * MIN;
    await waitFor(() => h.finished.length === 1, 3000);
    eq(h.engine.running.topicId, b);
    assert(h.engine._tickId !== 0, 'new tick source for the chained timer');
    let ticks = 0;
    h.engine.connect('tick', () => ticks++);
    await sleep(2200);
    assert(ticks >= 1 && ticks <= 3, `exactly one tick source, got ${ticks} ticks in 2.2 s`);
    h.done();
});

test('engine.destroy: removes the tick and the topics handler', () => {
    const h = makeEngine('destroy');
    h.engine.start(h.id('Study'));
    h.engine.destroy();
    eq(h.engine._tickId, 0);
    h.topics.delete(h.id('Study'));
    eq(Object.keys(h.engine.timers).length, 1, 'no longer reacts to topic changes');
    h.sessions.destroy();
});

// ---- format ----

test('formatClock: pads, rounds up, shows hours when needed', () => {
    eq(formatClock(45 * MIN), '45:00');
    eq(formatClock(45 * MIN - 1), '45:00');
    eq(formatClock(299_001), '05:00');
    eq(formatClock(299_000), '04:59');
    eq(formatClock(1), '00:01');
    eq(formatClock(0), '00:00');
    eq(formatClock(-5), '00:00');
    eq(formatClock(90 * MIN), '1:30:00');
    eq(formatClock(600 * MIN), '10:00:00');
});

test('formatDuration', () => {
    eq([0, 30, 59.6, 60, 2700, 3600, 8100, 36000].map(formatDuration),
        ['0s', '30s', '1m', '1m', '45m', '1h', '2h 15m', '10h']);
});

// ---- runner ----

async function main() {
    for (const [name, fn] of tests) {
        try {
            await fn();
            passed++;
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}\n     ${e.message}`);
        }
    }
    print(`\n${passed} passed, ${failed} failed`);
}

if (!GLib.file_test(`${ROOT}/schemas/gschemas.compiled`, GLib.FileTest.EXISTS)) {
    printerr('schemas/gschemas.compiled missing; run: glib-compile-schemas schemas');
    exit(2);
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    failed++;
    printerr(e.stack);
}).finally(() => {
    if (tmpDir)
        Gio.Subprocess.new(['rm', '-rf', tmpDir], Gio.SubprocessFlags.NONE).wait(null);
    loop.quit();
});
loop.run();
exit(failed ? 1 : 0);
