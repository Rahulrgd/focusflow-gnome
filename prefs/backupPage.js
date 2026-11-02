import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import * as Backup from '../lib/backup.js';

Gio._promisify(Gtk.FileDialog.prototype, 'save', 'save_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const escape = text => GLib.markup_escape_text(text, -1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function today() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d');
}

function fileFilter(name, patterns) {
    const filter = new Gtk.FileFilter({name});
    patterns.forEach(p => filter.add_pattern(p));
    return filter;
}

function isDismissed(e) {
    return e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) ||
        e.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED);
}

/** Export (JSON backup, CSV history), import (replace or merge) and reset. */
export const BackupPage = GObject.registerClass(
class BackupPage extends Adw.PreferencesPage {
    _init({window, settings, topics, sessions}) {
        super._init({title: 'Backup', icon_name: 'document-save-symbolic'});
        this._window = window;
        this._settings = settings;
        this._topics = topics;
        this._sessions = sessions;

        const exportGroup = new Adw.PreferencesGroup({title: 'Export'});
        exportGroup.add(this._row('Full backup', 'Topics, settings and all history as a JSON file',
            'Export…', () => this.chooseExport('json')));
        exportGroup.add(this._row('History as CSV', 'One row per session, for spreadsheets',
            'Export…', () => this.chooseExport('csv')));
        this.add(exportGroup);

        const importGroup = new Adw.PreferencesGroup({title: 'Import'});
        importGroup.add(this._row('Restore a backup', 'Replace your data with a FocusFlow backup, or merge it in',
            'Import…', () => this.chooseImport()));
        this.add(importGroup);

        const resetGroup = new Adw.PreferencesGroup({title: 'Reset'});
        const reset = this._row('Reset all data', 'Deletes every topic, all history and your settings',
            'Reset…', () => this.confirmReset());
        reset.button.add_css_class('destructive-action');
        resetGroup.add(reset);
        this.add(resetGroup);
    }

    _row(title, subtitle, label, onClicked) {
        const row = new Adw.ActionRow({title, subtitle});
        row.button = new Gtk.Button({label, valign: Gtk.Align.CENTER});
        row.button.connect('clicked', () => {
            onClicked().catch(e => {
                console.error(`FocusFlow prefs: ${e.message}`);
                this._toast(e.message);
            });
        });
        row.add_suffix(row.button);
        row.activatable_widget = row.button;
        return row;
    }

    async chooseExport(kind) {
        const dialog = new Gtk.FileDialog({
            title: kind === 'json' ? 'Export Backup' : 'Export History',
            initial_name: kind === 'json' ? `focusflow-backup-${today()}.json` : `focusflow-history-${today()}.csv`,
            modal: true,
        });
        let file;
        try {
            file = await dialog.save(this._window, null);
        } catch (e) {
            if (isDismissed(e))
                return;
            throw e;
        }
        await this.exportTo(file, kind);
    }

    /** Writes the backup (kind 'json') or history (kind 'csv') to `file`; returns the text. */
    async exportTo(file, kind) {
        // Re-read so sessions logged since the window opened are included.
        await this._sessions.load();
        const text = kind === 'json'
            ? `${JSON.stringify(Backup.buildBackup({
                topics: this._topics.all,
                sessions: this._sessions.sessions,
                settings: Backup.readSettings(this._settings),
            }), null, 1)}\n`
            : Backup.sessionsToCsv(this._sessions.sessions, this._topics.all);
        await file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(text)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        this._toast(`Saved ${file.get_basename()}`);
        return text;
    }

    async chooseImport() {
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(fileFilter('FocusFlow backups', ['*.json']));
        filters.append(fileFilter('All files', ['*']));
        const dialog = new Gtk.FileDialog({title: 'Import Backup', filters, modal: true});
        let file;
        try {
            file = await dialog.open(this._window, null);
        } catch (e) {
            if (isDismissed(e))
                return;
            throw e;
        }
        await this.importFrom(file);
    }

    /** Reads and checks a backup, then asks Replace / Merge; returns the dialog, or null if invalid. */
    async importFrom(file) {
        let backup;
        try {
            const [contents] = await file.load_contents_async(null);
            backup = Backup.parseBackup(new TextDecoder().decode(contents));
        } catch (e) {
            if (!(e instanceof Backup.BackupError) && !(e instanceof GLib.Error))
                throw e;
            this._toast(`Could not import ${file.get_basename()}: ${e.message}`);
            return null;
        }

        const lines = [`${plural(backup.topics.length, 'topic')} and ${plural(backup.sessions.length, 'session')}` +
            (backup.exportedAt ? `, exported ${new Date(backup.exportedAt).toLocaleString()}` : '') + '.'];
        if (backup.skippedTopics || backup.skippedSessions) {
            lines.push(`${plural(backup.skippedTopics, 'topic')} and ${plural(backup.skippedSessions, 'session')} ` +
                'in the file were invalid and will be skipped.');
        }
        lines.push('Replace deletes your current topics, history and settings. ' +
            'Merge keeps them and adds what is new from the backup.');

        const dialog = new Adw.AlertDialog({heading: 'Import Backup?', body: lines.join('\n\n')});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('merge', 'Merge');
        dialog.add_response('replace', 'Replace');
        dialog.set_response_appearance('replace', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('merge');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response === 'merge' || response === 'replace') {
                this.applyImport(backup, response).catch(e => {
                    console.error(`FocusFlow prefs: import failed: ${e.message}`);
                    this._toast(`Import failed: ${e.message}`);
                });
            }
        });
        dialog.present(this._window);
        dialog.backup = backup;
        return dialog;
    }

    /** mode 'replace' swaps all data for the backup; 'merge' adds what is new. */
    async applyImport(backup, mode) {
        if (mode === 'replace') {
            // Running timers would otherwise be logged into the new history
            // once their topics disappear; the shell drops them (extension.js).
            this._settings.set_boolean('clear-timers', true);
            await this._sessions.rewrite(backup.sessions);
            this._topics.replaceAll(backup.topics);
            this._settings.set_boolean('seeded', true);
            Backup.applySettings(this._settings, backup.settings);
            this._toast(`Restored ${plural(backup.topics.length, 'topic')} and ${plural(backup.sessions.length, 'session')}`);
            return;
        }

        const {topics, added: addedTopics} = Backup.mergeTopics(this._topics.all, backup.topics);
        if (addedTopics)
            this._topics.replaceAll(topics);
        let addedSessions = 0;
        await this._sessions.transform(local => {
            const merged = Backup.mergeSessions(local, backup.sessions);
            addedSessions = merged.added;
            return merged.added ? merged.sessions : local;
        });
        this._toast(`Added ${plural(addedTopics, 'topic')} and ${plural(addedSessions, 'session')}`);
    }

    async confirmReset() {
        const dialog = new Adw.AlertDialog({
            heading: 'Reset All Data?',
            body: 'This deletes every topic, all logged history and your settings, and brings back the ' +
                'default topics. It cannot be undone; export a backup first if you might want it back.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('reset', 'Reset Everything');
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response === 'reset') {
                this.resetAll().catch(e => {
                    console.error(`FocusFlow prefs: reset failed: ${e.message}`);
                    this._toast(`Reset failed: ${e.message}`);
                });
            }
        });
        dialog.present(this._window);
        return dialog;
    }

    async resetAll() {
        this._settings.set_boolean('clear-timers', true);
        await this._sessions.rewrite([]);
        for (const key of [...Backup.SETTINGS_KEYS, 'last-topic-id', 'purge-topic-ids'])
            this._settings.reset(key);
        this._topics.replaceAll([]);
        this._settings.set_boolean('seeded', false);
        this._topics.seedIfNeeded();
        this._toast('All data reset');
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title: escape(title), timeout: 4}));
    }
});
