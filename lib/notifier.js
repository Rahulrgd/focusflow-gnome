import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {formatDuration} from './format.js';
import {periodRange, secondsInRange} from './stats.js';

/**
 * Notification + sound when a timer finishes. The sound is played directly,
 * not as the notification's sound, so it still plays when notifications are
 * turned off or Do Not Disturb hides the banner.
 */
export class Notifier {
    constructor({settings, engine, topics, sessions, name, iconPath, soundPath}) {
        this._settings = settings;
        this._engine = engine;
        this._topics = topics;
        this._sessions = sessions;
        this._name = name;
        this._icon = Gio.icon_new_for_string(iconPath);
        this._soundFile = Gio.File.new_for_path(soundPath);
        this._source = null;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        engine.connectObject('finished', (_engine, session, late) => {
            this._onFinished(session, late).catch(e => console.error(`FocusFlow: notifying failed: ${e.message}`));
        }, this);
    }

    destroy() {
        this._destroyed = true;
        this._engine.disconnectObject(this);
        this._source?.destroy();
        this._source = null;
    }

    playSound() {
        const player = global.display.get_sound_player();
        if (this._soundFile.query_exists(null))
            player.play_from_file(this._soundFile, 'Timer finished', null);
        else
            player.play_from_theme('complete', 'Timer finished', null);
    }

    /** Builds and shows the notification for a finished session; returns it. */
    notify(session, late) {
        const topic = this._topics.find(session.topicId);
        const name = topic?.name ?? session.topicName;
        let body = `${formatDuration(this._todaySeconds(session))} of ${name} today`;
        if (late)
            body = `Ended at ${this._formatTime(session.end)} · ${body}`;

        // Auto-start (extension.js) runs before this, so its topic may already be running.
        const next = this._topics.find(this._settings.get_string('auto-chain-to'));
        const chained = next && next.id !== session.topicId && this._engine.running?.topicId === next.id;
        if (chained)
            body = `${body} · ${next.name} started`;

        const notification = new MessageTray.Notification({
            source: this._getSource(),
            title: `${name} finished`,
            body,
            urgency: MessageTray.Urgency.HIGH,
        });
        if (topic)
            notification.addAction('Start Again', () => this._engine.start(topic.id));
        if (next && next.id !== session.topicId && !chained)
            notification.addAction(`Start ${next.name}`, () => this._engine.start(next.id));
        this._getSource().addNotification(notification);
        return notification;
    }

    async _onFinished(session, late) {
        if (this._settings.get_boolean('sound-enabled'))
            this.playSound();
        if (!this._settings.get_boolean('notifications-enabled'))
            return;
        // Right after enable() the history may still be loading; wait for it so
        // "today" counts every session.
        try {
            await this._sessions.flush();
        } catch (e) {
            console.error(`FocusFlow: sessions not ready for the notification: ${e.message}`);
        }
        if (!this._destroyed)
            this.notify(session, late);
    }

    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: this._name, icon: this._icon});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    /**
     * Today's total for the session's topic, including the session itself;
     * a session that started yesterday counts only with its part after midnight.
     */
    _todaySeconds(session) {
        // The day the session ended in (a session ending at 00:00 belongs to the day before).
        const today = periodRange('daily', session.end - 1);
        // The session is appended asynchronously, so it may not be in the cache yet.
        const logged = this._sessions.sessions.filter(s => s.id !== session.id);
        return [...logged, session]
            .filter(s => s.topicId === session.topicId)
            .reduce((sum, s) => sum + secondsInRange(s, today), 0);
    }

    _formatTime(ms) {
        const twelveHour = this._interface.get_string('clock-format') === '12h';
        return GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000))
            .format(twelveHour ? '%l:%M %p' : '%H:%M').trim();
    }
}
