import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatClock} from './format.js';
import {MAX_MINUTES, MIN_MINUTES, TopicError} from './topicsModel.js';

function iconButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'focusflow-button',
        accessible_name: accessibleName,
        can_focus: true,
        child: new St.Icon({icon_name: iconName, icon_size: 16}),
    });
}

/**
 * One topic: color dot, name, editable minutes (or the countdown while it
 * has a timer), play/pause and reset, and a progress bar.
 */
const TopicRow = GObject.registerClass(
class TopicRow extends St.BoxLayout {
    _init(topic, engine, topics) {
        super._init({vertical: true, x_expand: true, style_class: 'focusflow-row'});
        this._engine = engine;
        this._topics = topics;

        const line = new St.BoxLayout({style_class: 'focusflow-row-line', x_expand: true});
        this.add_child(line);

        this._dot = new St.Widget({style_class: 'focusflow-dot', y_align: Clutter.ActorAlign.CENTER});
        line.add_child(this._dot);

        this._name = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        line.add_child(this._name);

        this._entry = new St.Entry({
            style_class: 'focusflow-minutes',
            can_focus: true,
            input_purpose: Clutter.InputContentPurpose.DIGITS,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const text = this._entry.clutter_text;
        text.max_length = String(MAX_MINUTES).length;
        text.connect('insert-text', (actor, newText) => {
            if (/\D/.test(newText))
                GObject.signal_stop_emission_by_name(actor, 'insert-text');
        });
        text.connect('activate', () => this._commitMinutes());
        text.connect('key-focus-out', () => this._commitMinutes());
        line.add_child(this._entry);

        this._unit = new St.Label({text: 'min', style_class: 'focusflow-unit', y_align: Clutter.ActorAlign.CENTER});
        line.add_child(this._unit);

        this._clock = new St.Label({style_class: 'focusflow-clock', y_align: Clutter.ActorAlign.CENTER});
        line.add_child(this._clock);

        this._playButton = iconButton('media-playback-start-symbolic', 'Start');
        this._playButton.connect('clicked', () => {
            if (this._engine.running?.topicId === this._topic.id)
                this._engine.pause(this._topic.id);
            else
                this._engine.start(this._topic.id);
        });
        line.add_child(this._playButton);

        this._resetButton = iconButton('view-refresh-symbolic', 'Reset');
        this._resetButton.connect('clicked', () => this._engine.reset(this._topic.id));
        line.add_child(this._resetButton);

        // The fill is scaled rather than sized, so it needs no allocated width.
        // y_expand too: in a BinLayout an empty child otherwise gets 0 px height.
        this._track = new St.Widget({
            style_class: 'focusflow-progress',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this._fill = new St.Widget({style_class: 'focusflow-progress-fill', x_expand: true, y_expand: true, pivot_point: new Graphene.Point({x: 0, y: 0})});
        this._track.add_child(this._fill);
        this.add_child(this._track);

        this.setTopic(topic);
    }

    get topicId() {
        return this._topic.id;
    }

    setTopic(topic) {
        this._topic = topic;
        this._name.text = topic.name;
        this._dot.style = `background-color: ${topic.color};`;
        this._fill.style = `background-color: ${topic.color};`;
        // Don't overwrite what the user is typing.
        if (!this._entry.clutter_text.has_key_focus())
            this._entry.text = String(topic.minutes);
        this.update();
    }

    /** Redraws the countdown, buttons and progress from the engine. */
    update() {
        const timer = this._engine.getTimer(this._topic.id);
        const running = timer?.status === 'running';

        this._entry.visible = this._unit.visible = !timer;
        this._clock.visible = this._track.visible = !!timer;
        if (timer) {
            this._clock.text = formatClock(this._engine.remainingMs(this._topic.id));
            this._fill.scale_x = Math.min(1, Math.max(0, this._engine.progress(this._topic.id)));
        }

        this._playButton.child.icon_name = running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playButton.accessible_name = running ? 'Pause' : timer ? 'Resume' : 'Start';
        this._resetButton.reactive = this._resetButton.can_focus = !!timer;
        this._resetButton.opacity = timer ? 255 : 90;

        if (running)
            this.add_style_class_name('focusflow-row-running');
        else
            this.remove_style_class_name('focusflow-row-running');
        if (timer?.status === 'paused')
            this.add_style_class_name('focusflow-row-paused');
        else
            this.remove_style_class_name('focusflow-row-paused');
    }

    _commitMinutes() {
        const minutes = parseInt(this._entry.text, 10);
        if (minutes === this._topic.minutes)
            return;
        if (!(minutes >= MIN_MINUTES && minutes <= MAX_MINUTES)) {
            this._entry.text = String(this._topic.minutes);
            return;
        }
        try {
            this._topics.update(this._topic.id, {minutes});
        } catch (e) {
            if (!(e instanceof TopicError))
                throw e;
            this._entry.text = String(this._topic.minutes);
        }
    }
});

/** Section 1 of the menu: one row per visible topic, scrollable when long. */
export const TimerList = GObject.registerClass(
class TimerList extends St.ScrollView {
    _init(engine, topics) {
        super._init({
            style_class: 'focusflow-timer-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._engine = engine;
        this._topics = topics;
        this._rows = [];

        this._box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'focusflow-timer-list'});
        this.set_child(this._box);

        this._empty = new St.Label({
            text: 'No visible topics',
            style_class: 'focusflow-empty',
        });
        this._empty.clutter_text.line_wrap = true;
        this._box.add_child(this._empty);

        this.syncTopics(topics.visible);
    }

    /** Rebuilds rows when the visible topics or their order change, else updates in place. */
    syncTopics(visible) {
        const sameIds = visible.length === this._rows.length &&
            visible.every((t, i) => this._rows[i].topicId === t.id);
        if (sameIds) {
            visible.forEach((t, i) => this._rows[i].setTopic(t));
        } else {
            this._rows.forEach(row => row.destroy());
            this._rows = visible.map(t => new TopicRow(t, this._engine, this._topics));
            this._rows.forEach(row => this._box.add_child(row));
        }
        this._empty.visible = this._rows.length === 0;
    }

    update() {
        this._rows.forEach(row => row.update());
    }
});
