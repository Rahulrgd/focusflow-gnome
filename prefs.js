import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SessionStore} from './lib/sessionStore.js';
import {TopicsStore} from './lib/topicsStore.js';
import {BackupPage} from './prefs/backupPage.js';
import {SettingsPage} from './prefs/settingsPage.js';
import {TopicsPage} from './prefs/topicsPage.js';

export default class FocusFlowPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._settings = settings;
        window.set_default_size(620, 680);

        const topics = new TopicsStore(settings);
        // The shell appends to it; here it is read (delete dialog, export) and
        // rewritten only by import and reset (backupPage.js).
        const sessions = new SessionStore();
        sessions.monitor();
        sessions.load().catch(e => console.error(`FocusFlow prefs: loading sessions failed: ${e.message}`));

        const topicsPage = new TopicsPage({window, settings, topics, sessions});
        window.add(topicsPage);
        const settingsPage = new SettingsPage({window, settings, topics});
        window.add(settingsPage);
        window.add(new BackupPage({window, settings, topics, sessions}));

        window.connect('close-request', () => {
            topicsPage.disconnectAll();
            settingsPage.disconnectAll();
            sessions.destroy();
            return false;
        });
    }
}
