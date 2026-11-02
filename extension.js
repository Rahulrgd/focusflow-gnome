import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {migrateSettings} from './lib/migrate.js';
import {SessionStore} from './lib/sessionStore.js';
import {TimerEngine} from './lib/timerEngine.js';
import {TopicsStore} from './lib/topicsStore.js';

export default class FocusFlowExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        migrateSettings(this._settings);

        this._topics = new TopicsStore(this._settings);
        this._topics.seedIfNeeded();

        this._sessions = new SessionStore();
        this._sessions.monitor();
        this._sessions.load().catch(e => console.error(`${this.uuid}: loading sessions failed: ${e.message}`));

        this._engine = new TimerEngine({
            settings: this._settings,
            topics: this._topics,
            sessions: this._sessions,
        });
        this._engine.checkFinished();
    }

    disable() {
        // session-modes includes unlock-dialog, so locking the screen keeps the
        // extension (and running timers) enabled. Timer state is saved in
        // GSettings, so a real disable/enable resumes where it left off.
        this._engine.destroy();
        this._engine = null;
        this._sessions.destroy();
        this._sessions = null;
        this._topics = null;
        this._settings = null;
    }
}
