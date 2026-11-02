import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {formatDuration} from '../lib/format.js';
import * as Model from '../lib/topicsModel.js';

function hexToRgba(hex) {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex);
    return rgba;
}

function rgbaToHex(rgba) {
    return `#${[rgba.red, rgba.green, rgba.blue]
        .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

function colorSwatch(hex) {
    const rgba = hexToRgba(hex);
    const area = new Gtk.DrawingArea({content_width: 14, content_height: 14, valign: Gtk.Align.CENTER});
    area.set_draw_func((_area, cr, width, height) => {
        Gdk.cairo_set_source_rgba(cr, rgba);
        cr.arc(width / 2, height / 2, Math.min(width, height) / 2, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    });
    return area;
}

function iconButton(iconName, tooltip, onClicked) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', onClicked);
    return button;
}

/**
 * Section 2, "Manage Topics": add, edit, reorder (drag or arrows),
 * hide/show and delete topics.
 */
export const TopicsPage = GObject.registerClass(
class TopicsPage extends Adw.PreferencesPage {
    _init({window, settings, topics, sessions}) {
        super._init({title: 'Topics', icon_name: 'view-list-symbolic'});
        this._window = window;
        this._settings = settings;
        this._topics = topics;
        this._sessions = sessions;
        this._rows = [];

        this._group = new Adw.PreferencesGroup({
            title: 'Topics',
            description: 'Drag a row or use the arrows to change the order in the menu. ' +
                'Hidden topics stay out of the menu but still count in the stats.',
        });
        const addButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: 'Add Topic'}),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this.openEditor(null));
        this._group.set_header_suffix(addButton);
        this.add(this._group);

        this._emptyRow = new Adw.ActionRow({
            title: 'No topics yet',
            subtitle: 'Add one to see it in the panel menu.',
        });

        this._topicsChangedId = topics.connectChanged(() => this._rebuild());
        this._rebuild();
    }

    /** Call when the window closes. */
    disconnectAll() {
        this._topics.disconnect(this._topicsChangedId);
    }

    _rebuild() {
        for (const row of this._rows)
            this._group.remove(row);
        const sorted = this._topics.sorted;
        this._rows = sorted.length
            ? sorted.map((t, i) => this._buildRow(t, i, sorted.length))
            : [this._emptyRow];
        for (const row of this._rows)
            this._group.add(row);
    }

    _buildRow(topic, index, count) {
        const name = GLib.markup_escape_text(topic.name, -1);
        const row = new Adw.ActionRow({
            title: topic.hidden ? `<span alpha="55%">${name}</span>` : name,
            subtitle: [
                `${topic.minutes} min`,
                topic.dailyGoalMinutes ? `goal ${formatDuration(topic.dailyGoalMinutes * 60)} a day` : null,
                topic.hidden ? 'Hidden' : null,
            ].filter(Boolean).join(' · '),
        });
        row.topicId = topic.id;

        // add_prefix() puts each prefix in front of the previous one.
        const swatch = colorSwatch(topic.color);
        swatch.opacity = topic.hidden ? 0.45 : 1;
        row.add_prefix(swatch);
        row.add_prefix(new Gtk.Image({icon_name: 'list-drag-handle-symbolic', css_classes: ['dim-label']}));

        const up = iconButton('go-up-symbolic', 'Move up', () => this._topics.move(topic.id, -1));
        up.sensitive = index > 0;
        const down = iconButton('go-down-symbolic', 'Move down', () => this._topics.move(topic.id, 1));
        down.sensitive = index < count - 1;
        row.add_suffix(up);
        row.add_suffix(down);
        row.add_suffix(iconButton('document-edit-symbolic', 'Edit', () => this.openEditor(topic)));
        row.add_suffix(iconButton(
            topic.hidden ? 'view-conceal-symbolic' : 'view-reveal-symbolic',
            topic.hidden ? 'Show in menu' : 'Hide from menu',
            () => this._topics.toggleHidden(topic.id)));
        const del = iconButton('user-trash-symbolic', 'Delete', () => this.confirmDelete(topic));
        del.add_css_class('error');
        row.add_suffix(del);

        const source = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        source.connect('prepare', () => Gdk.ContentProvider.new_for_value(topic.id));
        source.connect('drag-begin', (src, _drag) => {
            src.set_icon(Gtk.WidgetPaintable.new(row), row.get_width() / 2, row.get_height() / 2);
        });
        row.add_controller(source);

        const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        target.connect('drop', (_target, draggedId, _x, y) => {
            this.moveTo(draggedId, topic.id, y > row.get_height() / 2);
            return true;
        });
        row.add_controller(target);

        return row;
    }

    /** Moves `draggedId` just before (or after) `targetId`. */
    moveTo(draggedId, targetId, after) {
        if (draggedId === targetId)
            return;
        const ids = this._topics.sorted.map(t => t.id).filter(id => id !== draggedId);
        const at = ids.indexOf(targetId);
        if (at < 0)
            return;
        ids.splice(at + (after ? 1 : 0), 0, draggedId);
        this._topics.reorder(ids);
    }

    /** Opens the add (topic = null) or edit dialog; returns it. */
    openEditor(topic) {
        const dialog = new Adw.Dialog({title: topic ? 'Edit Topic' : 'Add Topic', content_width: 380});

        const cancel = new Gtk.Button({label: 'Cancel'});
        cancel.connect('clicked', () => dialog.close());
        const save = new Gtk.Button({label: topic ? 'Save' : 'Add', css_classes: ['suggested-action']});
        const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        header.pack_start(cancel);
        header.pack_end(save);

        const name = new Adw.EntryRow({title: 'Name', text: topic?.name ?? ''});
        const minutes = Adw.SpinRow.new_with_range(Model.MIN_MINUTES, Model.MAX_MINUTES, 1);
        minutes.title = 'Minutes';
        minutes.value = topic?.minutes ?? 25;
        const color = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            rgba: hexToRgba(topic?.color ?? Model.nextColor(this._topics.all)),
            valign: Gtk.Align.CENTER,
        });
        const colorRow = new Adw.ActionRow({title: 'Color', activatable_widget: color});
        colorRow.add_suffix(color);
        const goal = Adw.SpinRow.new_with_range(0, Model.MAX_GOAL_MINUTES, 5);
        goal.title = 'Daily goal (minutes)';
        goal.subtitle = '0 means no goal';
        goal.value = topic?.dailyGoalMinutes ?? 0;

        const group = new Adw.PreferencesGroup();
        group.add(name);
        group.add(minutes);
        group.add(colorRow);
        group.add(goal);

        const error = new Gtk.Label({
            css_classes: ['error'],
            wrap: true,
            xalign: 0,
            visible: false,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        box.append(group);
        box.append(error);

        const view = new Adw.ToolbarView({content: box});
        view.add_top_bar(header);
        dialog.set_child(view);

        const draft = () => ({
            id: topic?.id ?? '',
            name: name.text.trim(),
            minutes: Math.round(minutes.value),
            color: rgbaToHex(color.rgba),
            dailyGoalMinutes: Math.round(goal.value) || null,
        });
        const validate = () => {
            const errors = Model.validateTopic(draft(), this._topics.all);
            // Don't complain about the empty name before the user typed anything.
            const show = errors.length > 0 && name.text !== '';
            error.label = errors.join('\n');
            error.visible = show;
            if (show)
                name.add_css_class('error');
            else
                name.remove_css_class('error');
            save.sensitive = errors.length === 0;
            return errors.length === 0;
        };
        const submit = () => {
            if (!validate())
                return;
            const {name: newName, minutes: newMinutes, color: newColor, dailyGoalMinutes} = draft();
            const fields = {name: newName, minutes: newMinutes, color: newColor, dailyGoalMinutes};
            try {
                if (topic)
                    this._topics.update(topic.id, fields);
                else
                    this._topics.add(fields);
            } catch (e) {
                if (!(e instanceof Model.TopicError))
                    throw e;
                error.label = e.message;
                error.visible = true;
                return;
            }
            dialog.close();
            this._toast(topic ? `Saved “${newName}”` : `Added “${newName}”`);
        };

        name.connect('changed', validate);
        name.connect('entry-activated', submit);
        minutes.connect('notify::value', validate);
        goal.connect('notify::value', validate);
        color.connect('notify::rgba', validate);
        save.connect('clicked', submit);
        validate();

        dialog.present(this._window);
        name.grab_focus();
        return dialog;
    }

    /** Asks how to delete a topic; returns the dialog. */
    confirmDelete(topic) {
        const logged = this._sessions.sessions.filter(s => s.topicId === topic.id).length;
        const dialog = new Adw.AlertDialog({
            heading: `Delete “${topic.name}”?`,
            body: logged
                ? `It has ${logged} logged session${logged === 1 ? '' : 's'}. ` +
                  'Keep them in the stats, or delete them too? Its timer, if any, is stopped.'
                : 'It has no logged time yet. Its timer, if any, is stopped.',
        });
        dialog.add_response('cancel', 'Cancel');
        if (logged) {
            dialog.add_response('keep', 'Keep History');
            dialog.add_response('purge', 'Delete History');
            dialog.set_response_appearance('purge', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('keep');
        } else {
            dialog.add_response('keep', 'Delete');
            dialog.set_response_appearance('keep', Adw.ResponseAppearance.DESTRUCTIVE);
        }
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => this.deleteTopic(topic, response));
        dialog.present(this._window);
        return dialog;
    }

    /** response: 'keep' deletes the topic only, 'purge' also its history. */
    deleteTopic(topic, response) {
        if (response !== 'keep' && response !== 'purge')
            return;
        if (response === 'purge') {
            // The shell does the purge, before it sees the topic disappear, so
            // a running timer is dropped instead of logged. See extension.js.
            const ids = this._settings.get_strv('purge-topic-ids');
            this._settings.set_strv('purge-topic-ids', [...new Set([...ids, topic.id])]);
        }
        this._topics.delete(topic.id);
        this._toast(response === 'purge'
            ? `Deleted “${topic.name}” and its history`
            : `Deleted “${topic.name}”`);
    }

    _toast(title) {
        // Toast titles are markup; topic names may contain < or &.
        this._window.add_toast(new Adw.Toast({title: GLib.markup_escape_text(title, -1), timeout: 3}));
    }
});
