// Unit tests for the modules that don't need a running shell.
// Run from the repo root: glib-compile-schemas schemas && gjs -m tests/run.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {exit} from 'system';

import * as Model from '../lib/topicsModel.js';
import {migrateData, migrateSettings, SCHEMA_VERSION} from '../lib/migrate.js';
import {isValidSession, parseSessionLines, SessionStore} from '../lib/sessionStore.js';
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
