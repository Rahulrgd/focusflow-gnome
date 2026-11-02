import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class FocusFlowPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'Topics',
            icon_name: 'view-list-symbolic',
        });
        window.add(page);

        const topics = new Adw.PreferencesGroup({
            title: 'Topics',
            description: 'Topic management arrives in Phase 4.',
        });
        page.add(topics);
    }
}
