import {parseTopics} from './topicsModel.js';

// Bump SCHEMA_VERSION and add MIGRATIONS[n] (upgrades data from v n to v n + 1)
// whenever the stored shape of topics or sessions changes.
export const SCHEMA_VERSION = 1;

const MIGRATIONS = {};

/**
 * Upgrades `{schemaVersion, topics, sessions, ...}` to SCHEMA_VERSION.
 * Used for stored data on startup and for imported backups.
 */
export function migrateData(data) {
    let version = data.schemaVersion ?? 1;
    if (!Number.isInteger(version) || version < 1)
        throw new Error(`Invalid schema version: ${version}`);
    if (version > SCHEMA_VERSION)
        throw new Error(`Data is from a newer FocusFlow (schema v${version}, this one supports v${SCHEMA_VERSION})`);

    let out = data;
    for (; version < SCHEMA_VERSION; version++)
        out = MIGRATIONS[version](out);
    return {...out, schemaVersion: SCHEMA_VERSION};
}

/** Migrates the topics stored in GSettings; returns false if the data is newer than this code. */
export function migrateSettings(settings) {
    const version = settings.get_int('schema-version');
    if (version === SCHEMA_VERSION)
        return true;
    try {
        const {topics} = migrateData({
            schemaVersion: version,
            topics: parseTopics(settings.get_string('topics')),
        });
        settings.set_string('topics', JSON.stringify(topics));
        settings.set_int('schema-version', SCHEMA_VERSION);
        return true;
    } catch (e) {
        console.error(`FocusFlow: ${e.message}`);
        return false;
    }
}
