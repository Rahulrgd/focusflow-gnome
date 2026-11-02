import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'append_to_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');

export const SESSIONS_FILE =
    GLib.build_filenamev([GLib.get_user_data_dir(), 'focusflow', 'sessions.jsonl']);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isValidSession(s) {
    return !!s && typeof s === 'object' &&
        typeof s.id === 'string' && s.id !== '' &&
        typeof s.topicId === 'string' && s.topicId !== '' &&
        typeof s.topicName === 'string' &&
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start &&
        Number.isFinite(s.seconds) && s.seconds >= 0 &&
        typeof s.completed === 'boolean';
}

/** Parses JSON Lines, skipping blank lines; returns the sessions and how many bad lines were dropped. */
export function parseSessionLines(text) {
    const sessions = [];
    let skipped = 0;
    for (const line of text.split('\n')) {
        if (line.trim() === '')
            continue;
        let session;
        try {
            session = JSON.parse(line);
        } catch {
            session = null;
        }
        if (isValidSession(session))
            sessions.push(session);
        else
            skipped++;
    }
    return {sessions, skipped};
}

function serialize(sessions) {
    return sessions.map(s => `${JSON.stringify(s)}\n`).join('');
}

// Session history in a JSON Lines file. The shell only appends; prefs rewrites
// the file for delete-history and import. All file operations go through one
// queue so they never interleave, and a file monitor reloads the cache when
// another process changes the file.
export class SessionStore {
    constructor(path = SESSIONS_FILE) {
        this._file = Gio.File.new_for_path(path);
        this._sessions = [];
        this._queue = Promise.resolve();
        this._cancellable = new Gio.Cancellable();
        this._callbacks = new Map();
        this._nextCallbackId = 1;
        this._monitor = null;
        this._stamp = null;
        this._dirReady = false;
    }

    /** Cached sessions in file order; do not mutate. */
    get sessions() {
        return this._sessions;
    }

    get path() {
        return this._file.get_path();
    }

    load() {
        return this._enqueue(() => this._load());
    }

    append(session) {
        if (!isValidSession(session))
            return Promise.reject(new Error(`Invalid session: ${JSON.stringify(session)}`));
        return this._enqueue(async () => {
            this._ensureDir();
            const stream = await this._file.append_to_async(
                Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
            try {
                // GLib.Bytes, not a plain Uint8Array: GJS does not keep a JS
                // buffer alive for the duration of an async write.
                let bytes = new GLib.Bytes(encoder.encode(serialize([session])));
                while (bytes.get_size() > 0) {
                    const written = await stream.write_bytes_async(bytes,
                        GLib.PRIORITY_DEFAULT, this._cancellable);
                    bytes = bytes.new_from_bytes(written, bytes.get_size() - written);
                }
            } finally {
                await stream.close_async(GLib.PRIORITY_DEFAULT, null);
            }
            this._sessions = [...this._sessions, session];
            this._stamp = await this._readStamp();
            this._notify();
        });
    }

    /** Atomically replaces the whole file (temp file + rename). */
    rewrite(sessions) {
        const bad = sessions.find(s => !isValidSession(s));
        if (bad)
            return Promise.reject(new Error(`Invalid session: ${JSON.stringify(bad)}`));
        return this._enqueue(async () => {
            this._ensureDir();
            if (sessions.length === 0) {
                // Empty GLib.Bytes reach GIO as a NULL buffer and the write
                // never completes, so truncate via an empty replace stream.
                const stream = await this._file.replace_async(null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, GLib.PRIORITY_DEFAULT, this._cancellable);
                await stream.close_async(GLib.PRIORITY_DEFAULT, null);
            } else {
                const bytes = new GLib.Bytes(encoder.encode(serialize(sessions)));
                await this._file.replace_contents_bytes_async(bytes, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);
            }
            this._sessions = [...sessions];
            this._stamp = await this._readStamp();
            this._notify();
        });
    }

    /** Starts watching the file for changes made by another process. */
    monitor() {
        if (this._monitor)
            return;
        this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.connect('changed', (_m, _file, _other, event) => {
            if (event === Gio.FileMonitorEvent.CHANGED)
                return; // wait for CHANGES_DONE_HINT
            this._enqueue(async () => {
                // Skip events caused by our own writes.
                if (await this._readStamp() !== this._stamp)
                    await this._load();
            }).catch(e => console.error(`FocusFlow: reloading sessions failed: ${e.message}`));
        });
    }

    /** Calls `callback(sessions)` after every load, append or rewrite; returns an id. */
    connectChanged(callback) {
        const id = this._nextCallbackId++;
        this._callbacks.set(id, callback);
        return id;
    }

    disconnect(id) {
        this._callbacks.delete(id);
    }

    destroy() {
        this._cancellable.cancel();
        this._monitor?.cancel();
        this._monitor = null;
        this._callbacks.clear();
    }

    _enqueue(task) {
        const result = this._queue.then(task);
        this._queue = result.catch(() => {});
        return result;
    }

    async _load() {
        let text = '';
        try {
            const [contents] = await this._file.load_contents_async(this._cancellable);
            text = decoder.decode(contents);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw e;
        }
        const {sessions, skipped} = parseSessionLines(text);
        if (skipped)
            console.warn(`FocusFlow: skipped ${skipped} malformed line(s) in ${this.path}`);
        this._sessions = sessions;
        this._stamp = await this._readStamp();
        this._notify();
    }

    /** Size + mtime of the file, or null if it does not exist. */
    async _readStamp() {
        try {
            const info = await this._file.query_info_async('standard::size,time::modified',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
            return `${info.get_size()}:${info.get_modification_date_time()?.to_unix_usec()}`;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return null;
            throw e;
        }
    }

    _ensureDir() {
        if (this._dirReady)
            return;
        GLib.mkdir_with_parents(this._file.get_parent().get_path(), 0o700);
        this._dirReady = true;
    }

    _notify() {
        for (const callback of this._callbacks.values()) {
            try {
                callback(this._sessions);
            } catch (e) {
                console.error(`FocusFlow: sessions callback failed: ${e.message}`);
            }
        }
    }
}
