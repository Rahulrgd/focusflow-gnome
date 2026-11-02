import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class FocusFlowExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        console.log(`${this.uuid}: enabled (schema v${this._settings.get_int('schema-version')})`);
    }

    disable() {
        // Also called on the lock screen (session-modes includes unlock-dialog),
        // so everything created in enable() must be torn down here.
        this._settings = null;
        console.log(`${this.uuid}: disabled`);
    }
}
