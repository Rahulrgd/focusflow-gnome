import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatClock} from './format.js';
import {lastPausedTimer} from './timerMath.js';
import {TimerList} from './timerList.js';

/**
 * Panel button with the running topic's countdown, and the menu:
 * Section 1 timers, Section 2 "Manage Topics", Section 3 stats.
 */
export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init({engine, topics, name, iconPath, openPreferences}) {
        super._init(0.5, name, false);
        this._engine = engine;
        this._topics = topics;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon',
        }));
        this._label = new St.Label({
            style_class: 'focusflow-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._label);
        this.add_child(box);

        this.menu.box.add_style_class_name('focusflow-menu');

        // Section 1: timers. A plain section, not a non-reactive menu item:
        // St marks non-reactive widgets :insensitive and the theme greys out
        // everything inside them.
        const timers = new PopupMenu.PopupMenuSection();
        this._timerList = new TimerList(engine, topics);
        timers.actor.add_child(this._timerList);
        this.menu.addMenuItem(timers);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Section 2: manage topics
        const manage = new PopupMenu.PopupImageMenuItem('Manage Topics…', 'emblem-system-symbolic');
        manage.connect('activate', () => openPreferences());
        this.menu.addMenuItem(manage);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Section 3: stats (Phase 5)
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Stats', {reactive: false}));

        engine.connectObject(
            'changed', () => this._sync(),
            'tick', () => this._sync(),
            this);
        this._topicsChangedId = topics.connectChanged(() => {
            this._timerList.syncTopics(topics.visible);
            this._sync();
        });
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._timerList.update();
        });
        // Timers keep running on the lock screen, but the menu must not be reachable there.
        Main.sessionMode.connectObject('updated', () => this.syncSessionMode(), this);

        this.connect('destroy', () => {
            this._topics.disconnect(this._topicsChangedId);
            this._topicsChangedId = 0;
        });

        this._sync();
    }

    /** Hides the indicator on the lock screen; call again once it is in the panel. */
    syncSessionMode() {
        const locked = Main.sessionMode.isLocked;
        // No animation: the indicator may be destroyed right after this.
        if (locked)
            this.menu.close(BoxPointer.PopupAnimation.NONE);
        this.container.visible = !locked;
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_MIDDLE) {
            this._engine.toggle();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    _sync() {
        if (this.menu.isOpen)
            this._timerList.update();
        this._syncPanelLabel();
    }

    _syncPanelLabel() {
        const timer = this._engine.running ?? lastPausedTimer(this._engine.timers);
        this._label.visible = !!timer;
        if (!timer)
            return;
        const name = this._topics.find(timer.topicId)?.name ?? timer.topicName;
        const clock = formatClock(this._engine.remainingMs(timer.topicId));
        this._label.text = timer.status === 'paused' ? `⏸ ${name} ${clock}` : `${name} ${clock}`;
    }
});
