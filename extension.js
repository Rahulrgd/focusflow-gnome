import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {migrateSettings} from './lib/migrate.js';
import {SessionStore} from './lib/sessionStore.js';
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
    }

    disable() {
        // Also called on the lock screen (session-modes includes unlock-dialog),
        // so everything created in enable() must be torn down here.
        this._sessions.destroy();
        this._sessions = null;
        this._topics = null;
        this._settings = null;
    }
}
