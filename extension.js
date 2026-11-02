import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Indicator} from './lib/indicator.js';
import {migrateSettings} from './lib/migrate.js';
import {Notifier} from './lib/notifier.js';
import {SessionStore} from './lib/sessionStore.js';
import {TimerEngine} from './lib/timerEngine.js';
import {TopicsStore} from './lib/topicsStore.js';

export default class FocusFlowExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        migrateSettings(this._settings);

        this._topics = new TopicsStore(this._settings);
        this._topics.seedIfNeeded();

        // A "replace all data" from the preferences window while the shell was not
        // running: drop the old timers before the engine loads them.
        if (this._settings.get_boolean('clear-timers')) {
            this._settings.set_string('timers', '{}');
            this._settings.set_boolean('clear-timers', false);
        }

        this._sessions = new SessionStore();
        this._sessions.monitor();
        this._sessions.load().catch(e => console.error(`${this.uuid}: loading sessions failed: ${e.message}`));

        this._engine = new TimerEngine({
            settings: this._settings,
            topics: this._topics,
            sessions: this._sessions,
        });

        this._indicator = new Indicator({
            settings: this._settings,
            engine: this._engine,
            topics: this._topics,
            sessions: this._sessions,
            name: this.metadata.name,
            iconPath: `${this.path}/icons/focusflow-symbolic.svg`,
            openPreferences: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._indicator.syncSessionMode();

        // Before checkFinished(), so a timer that ended while the shell was not
        // running still gets its notification.
        this._notifier = new Notifier({
            settings: this._settings,
            engine: this._engine,
            topics: this._topics,
            sessions: this._sessions,
            name: this.metadata.name,
            iconPath: `${this.path}/icons/focusflow-symbolic.svg`,
            soundPath: `${this.path}/sounds/done.oga`,
        });

        this._engine.connectObject('finished', (_engine, session, late) => this._autoStart(session, late), this);

        Main.wm.addKeybinding('toggle-timer', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._engine.toggle());

        this._settings.connectObject(
            'changed::purge-topic-ids', () => this._purgeTopics(),
            'changed::clear-timers', () => this._clearTimers(),
            this);
        this._purgeTopics();

        // GLib timeouts do not run during suspend; on resume, finish an overdue
        // timer right away instead of on the next tick.
        this._sleepSignalId = Gio.DBus.system.signal_subscribe('org.freedesktop.login1',
            'org.freedesktop.login1.Manager', 'PrepareForSleep', '/org/freedesktop/login1', null,
            Gio.DBusSignalFlags.NONE, (_conn, _sender, _path, _iface, _signal, params) => {
                const [goingToSleep] = params.deepUnpack();
                if (!goingToSleep)
                    this._engine?.checkFinished();
            });

        this._engine.checkFinished();
    }

    /**
     * Import (Replace) and "Reset all data" set this before swapping all topics,
     * so running timers are dropped instead of logged into the new history.
     */
    _clearTimers() {
        if (!this._settings.get_boolean('clear-timers'))
            return;
        this._engine.forgetAll();
        this._settings.set_boolean('clear-timers', false);
    }

    /**
     * Auto-start: after one of the chosen topics finishes, start the chosen
     * next topic from its full length. Not for finishes noticed late (after
     * suspend or a shell restart): that break would already be over.
     */
    _autoStart(session, late) {
        if (late || !this._settings.get_boolean('auto-chain-enabled'))
            return;
        if (!this._settings.get_strv('auto-chain-from').includes(session.topicId))
            return;
        const next = this._settings.get_string('auto-chain-to');
        if (!next || next === session.topicId || !this._topics.find(next))
            return;
        this._engine.reset(next);
        this._engine.start(next);
    }

    /**
     * Handles "Delete with History" from the preferences window, which lists
     * the topic here before deleting it, so its running timer is dropped
     * instead of logged, then its sessions are removed.
     */
    _purgeTopics() {
        const ids = this._settings.get_strv('purge-topic-ids');
        if (ids.length === 0)
            return;
        ids.forEach(id => this._engine.forget(id));
        this._settings.set_strv('purge-topic-ids', []);
        this._sessions.removeTopics(ids)
            .catch(e => console.error(`${this.uuid}: deleting history failed: ${e.message}`));
    }

    disable() {
        // Locking the screen can also disable and re-enable this extension:
        // GNOME does that to every extension enabled after one without
        // lock-screen support. Timer state is saved in GSettings and based on
        // the wall clock, so timers carry on across that and any real
        // disable/enable.
        Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
        this._sleepSignalId = 0;
        Main.wm.removeKeybinding('toggle-timer');
        this._settings.disconnectObject(this);
        this._engine.disconnectObject(this);
        this._notifier.destroy();
        this._notifier = null;
        this._indicator.destroy();
        this._indicator = null;
        this._engine.destroy();
        this._engine = null;
        this._sessions.destroy();
        this._sessions = null;
        this._topics = null;
        this._settings = null;
    }
}
