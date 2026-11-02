import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SessionStore} from './lib/sessionStore.js';
import {TopicsStore} from './lib/topicsStore.js';
import {TopicsPage} from './prefs/topicsPage.js';

export default class FocusFlowPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._settings = settings;
        window.set_default_size(620, 680);

        const topics = new TopicsStore(settings);
        // Read-only here (session counts for the delete dialog); the shell writes it.
        const sessions = new SessionStore();
        sessions.monitor();
        sessions.load().catch(e => console.error(`FocusFlow prefs: loading sessions failed: ${e.message}`));

        const topicsPage = new TopicsPage({window, settings, topics, sessions});
        window.add(topicsPage);

        window.connect('close-request', () => {
            topicsPage.disconnectAll();
            sessions.destroy();
            return false;
        });
    }
}
