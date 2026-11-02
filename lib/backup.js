// Backup helpers: building/parsing the JSON backup, merging, CSV export, and
// reading/applying the backed-up settings. No Shell or GTK imports, so they
// also run under plain gjs (tests/run.js).

import GLib from 'gi://GLib';

import {migrateData, SCHEMA_VERSION} from './migrate.js';
import {isValidSession} from './sessionStore.js';
import {splitByDay} from './stats.js';
import {MAX_NAME_LENGTH, parseTopics, sortTopics} from './topicsModel.js';

export const BACKUP_APP = 'focusflow';

/** Settings that go into a backup (not runtime state like timers). */
export const SETTINGS_KEYS = [
    'sound-enabled', 'notifications-enabled', 'panel-show-countdown', 'week-start',
    'stats-period', 'auto-chain-enabled', 'auto-chain-from', 'auto-chain-to', 'toggle-timer',
];

export class BackupError extends Error {}

export function readSettings(settings) {
    return Object.fromEntries(SETTINGS_KEYS.map(key => [key, settings.get_value(key).deepUnpack()]));
}

/** Applies backed-up settings; skips unknown keys and values of the wrong type or range. */
export function applySettings(settings, values) {
    const schema = settings.settings_schema;
    for (const key of SETTINGS_KEYS) {
        if (!(key in values))
            continue;
        let variant;
        try {
            variant = new GLib.Variant(schema.get_key(key).get_value_type().dup_string(), values[key]);
        } catch {
            continue;
        }
        if (schema.get_key(key).range_check(variant))
            settings.set_value(key, variant);
    }
}

export function buildBackup({topics, sessions, settings, now = Date.now()}) {
    return {
        app: BACKUP_APP,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date(now).toISOString(),
        topics: sortTopics(topics),
        settings,
        sessions,
    };
}

/**
 * Parses and validates a backup file's text. Invalid topics and sessions are
 * dropped and counted rather than failing the whole import.
 *
 * @returns {{topics, sessions, settings, exportedAt, skippedTopics, skippedSessions}}
 */
export function parseBackup(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new BackupError('The file is not valid JSON');
    }
    if (!data || typeof data !== 'object' || data.app !== BACKUP_APP)
        throw new BackupError('This is not a FocusFlow backup');
    if (!Array.isArray(data.topics) || !Array.isArray(data.sessions))
        throw new BackupError('The backup has no topics or sessions list');
    try {
        data = migrateData(data);
    } catch (e) {
        throw new BackupError(e.message);
    }

    const topics = parseTopics(JSON.stringify(data.topics));
    const sessions = data.sessions.filter(isValidSession);
    const uniqueSessions = [...new Map(sessions.map(s => [s.id, s])).values()];
    return {
        topics,
        sessions: uniqueSessions,
        settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
        exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null,
        skippedTopics: data.topics.length - topics.length,
        skippedSessions: data.sessions.length - uniqueSessions.length,
    };
}

function uniqueName(name, taken) {
    if (!taken.has(name.toLowerCase()))
        return name;
    for (let n = 2; ; n++) {
        const suffix = ` (${n})`;
        const candidate = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
        if (!taken.has(candidate.toLowerCase()))
            return candidate;
    }
}

/**
 * Keeps every local topic as it is and adds the imported topics whose id is
 * new, after the local ones; a clashing name gets a " (2)" suffix.
 */
export function mergeTopics(local, imported) {
    const ids = new Set(local.map(t => t.id));
    const taken = new Set(local.map(t => t.name.toLowerCase()));
    let order = local.length ? Math.max(...local.map(t => t.order)) + 1 : 0;
    const added = [];
    for (const topic of sortTopics(imported)) {
        if (ids.has(topic.id))
            continue;
        const name = uniqueName(topic.name, taken);
        taken.add(name.toLowerCase());
        added.push({...topic, name, order: order++});
    }
    return {topics: [...local, ...added], added: added.length};
}

/** Union of both by session id (local wins), sorted by start time. */
export function mergeSessions(local, imported) {
    const byId = new Map(local.map(s => [s.id, s]));
    let added = 0;
    for (const s of imported) {
        if (!byId.has(s.id)) {
            byId.set(s.id, s);
            added++;
        }
    }
    return {sessions: [...byId.values()].sort((a, b) => a.start - b.start), added};
}

const pad = n => String(n).padStart(2, '0');

function csvField(value) {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One row per session per day, in local time: date,start,end,topic,minutes,completed.
 * A session crossing midnight gets a row for each day (the first ends at 24:00);
 * only the last row of a completed session says "yes".
 */
export function sessionsToCsv(sessions, topics = []) {
    const names = new Map(topics.map(t => [t.id, t.name]));
    const rows = [];
    for (const s of [...sessions].sort((a, b) => a.start - b.start)) {
        const pieces = splitByDay(s);
        pieces.forEach((piece, i) => {
            const start = new Date(piece.start);
            const end = new Date(piece.end);
            const last = i === pieces.length - 1;
            rows.push([
                `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
                `${pad(start.getHours())}:${pad(start.getMinutes())}`,
                last ? `${pad(end.getHours())}:${pad(end.getMinutes())}` : '24:00',
                names.get(s.topicId) ?? s.topicName,
                (piece.seconds / 60).toFixed(1),
                s.completed && last ? 'yes' : 'no',
            ].map(csvField).join(','));
        });
    }
    return ['date,start,end,topic,minutes,completed', ...rows].join('\n') + '\n';
}
