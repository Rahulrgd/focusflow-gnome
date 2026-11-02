import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

const WEEK_STARTS = [['mon', 'Monday'], ['sun', 'Sunday']];

// Adw rows and group descriptions are Pango markup, so text with < or & must be escaped.
const escape = text => GLib.markup_escape_text(text, -1);

/** Parses an accelerator like "<Super><Alt>p"; returns its display label, or null if invalid. */
export function acceleratorLabel(accel) {
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    if (!ok || key === 0)
        return null;
    return Gtk.accelerator_get_label(key, mods);
}

/** Sound, notifications, panel, stats, auto-start and shortcut settings. */
export const SettingsPage = GObject.registerClass(
class SettingsPage extends Adw.PreferencesPage {
    _init({window, settings, topics}) {
        super._init({title: 'Settings', icon_name: 'preferences-system-symbolic'});
        this._window = window;
        this._settings = settings;
        this._topics = topics;
        this._fromRows = [];
        this._settingsChangedIds = [];

        this._buildFinishGroup();
        this._buildChainGroup();
        this._buildPanelGroup();
        this._buildShortcutGroup();

        this._topicsChangedId = topics.connectChanged(() => this._syncTopics());
        for (const key of ['auto-chain-from', 'auto-chain-to', 'toggle-timer'])
            this._settingsChangedIds.push(settings.connect(`changed::${key}`, () => this._syncFromSettings()));
        this._syncTopics();
    }

    /** Call when the window closes. */
    disconnectAll() {
        this._topics.disconnect(this._topicsChangedId);
        this._settingsChangedIds.forEach(id => this._settings.disconnect(id));
    }

    _switch(group, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    }

    _buildFinishGroup() {
        const group = new Adw.PreferencesGroup({title: 'When a Timer Finishes'});
        this._switch(group, 'sound-enabled', 'Play a sound',
            'Also plays when notifications are off or Do Not Disturb is on');
        this._switch(group, 'notifications-enabled', 'Show a notification');
        this.add(group);
    }

    _buildChainGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Auto-Start',
            description: 'Start another topic automatically when a timer finishes, e.g. a break after studying.',
        });
        this._switch(group, 'auto-chain-enabled', 'Start next topic automatically');
        this.add(group);

        // A separate group, so its sensitivity can follow the switch: AdwComboRow
        // resets its own 'sensitive' whenever its model changes.
        const choices = new Adw.PreferencesGroup();
        this._fromRow = new Adw.ExpanderRow({title: 'After these topics'});
        choices.add(this._fromRow);

        this._toModel = new Gtk.StringList();
        this._toRow = new Adw.ComboRow({title: 'Then start', model: this._toModel});
        this._toRow.connect('notify::selected', () => {
            if (this._syncing)
                return;
            const topic = this._toTopics[this._toRow.selected - 1];
            this._settings.set_string('auto-chain-to', topic?.id ?? '');
        });
        choices.add(this._toRow);

        // NO_SENSITIVITY: otherwise bind() also ties 'sensitive' to the key's
        // writability, which overrides this binding.
        this._settings.bind('auto-chain-enabled', choices, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
        this.add(choices);
    }

    _buildPanelGroup() {
        const group = new Adw.PreferencesGroup({title: 'Panel and Stats'});
        this._switch(group, 'panel-show-countdown', 'Show topic and countdown in the top bar',
            'When off, only the icon shows whether a timer is running or paused');

        const weekStart = new Adw.ComboRow({
            title: 'First day of the week',
            model: Gtk.StringList.new(WEEK_STARTS.map(([, label]) => label)),
        });
        const syncWeek = () => {
            weekStart.selected = Math.max(0, WEEK_STARTS.findIndex(([v]) => v === this._settings.get_string('week-start')));
        };
        syncWeek();
        weekStart.connect('notify::selected', () =>
            this._settings.set_string('week-start', WEEK_STARTS[weekStart.selected][0]));
        this._settingsChangedIds.push(this._settings.connect('changed::week-start', syncWeek));
        group.add(weekStart);
        this.add(group);
    }

    _buildShortcutGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcut',
            description: escape('Pauses the running timer, or resumes the last paused one, or starts the last used topic. ' +
                'Type it like <Super><Alt>p or <Ctrl><Shift>F8; leave empty to turn it off.'),
        });
        this._shortcutRow = new Adw.EntryRow({title: 'Pause / resume', show_apply_button: true});
        this._shortcutRow.connect('apply', () => this.applyShortcut(this._shortcutRow.text));

        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Reset to default',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => this._settings.reset('toggle-timer'));
        this._shortcutRow.add_suffix(reset);
        group.add(this._shortcutRow);

        this._shortcutLabel = new Adw.ActionRow({title: 'Current shortcut'});
        group.add(this._shortcutLabel);
        this.add(group);
    }

    /** Saves a typed accelerator; returns false (and shows a toast) if it is invalid. */
    applyShortcut(text) {
        const accel = text.trim();
        if (accel === '') {
            this._settings.set_strv('toggle-timer', []);
            return true;
        }
        if (!acceleratorLabel(accel)) {
            this._window.add_toast(new Adw.Toast({title: escape(`“${accel}” is not a valid shortcut`), timeout: 4}));
            return false;
        }
        this._settings.set_strv('toggle-timer', [accel]);
        return true;
    }

    _syncTopics() {
        const topics = this._topics.sorted;

        for (const row of this._fromRows)
            this._fromRow.remove(row);
        this._fromRows = topics.map(topic => {
            const check = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
            const row = new Adw.ActionRow({title: escape(topic.name), activatable_widget: check});
            row.topicName = topic.name;
            row.add_prefix(check);
            row.topicId = topic.id;
            row.check = check;
            check.connect('toggled', () => {
                if (this._syncing)
                    return;
                const ids = new Set(this._settings.get_strv('auto-chain-from'));
                if (check.active)
                    ids.add(topic.id);
                else
                    ids.delete(topic.id);
                this._settings.set_strv('auto-chain-from', [...ids]);
            });
            this._fromRow.add_row(row);
            return row;
        });

        this._toTopics = topics;
        this._syncing = true;
        this._toModel.splice(0, this._toModel.get_n_items(), ['None', ...topics.map(t => t.name)]);
        this._syncing = false;
        this._syncFromSettings();
    }

    _syncFromSettings() {
        this._syncing = true;
        const from = new Set(this._settings.get_strv('auto-chain-from'));
        for (const row of this._fromRows)
            row.check.active = from.has(row.topicId);
        const names = this._fromRows.filter(r => from.has(r.topicId)).map(r => r.topicName);
        this._fromRow.subtitle = names.length ? escape(names.join(', ')) : 'None selected';

        const to = this._settings.get_string('auto-chain-to');
        this._toRow.selected = this._toTopics.findIndex(t => t.id === to) + 1;

        const accel = this._settings.get_strv('toggle-timer')[0] ?? '';
        if (this._shortcutRow.text !== accel)
            this._shortcutRow.text = accel;
        this._shortcutLabel.subtitle = accel ? escape(acceleratorLabel(accel) ?? accel) : 'Off';
        this._syncing = false;
    }
});
