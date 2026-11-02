import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatDuration} from './format.js';
import * as Stats from './stats.js';
import {segmentToSession} from './timerMath.js';

const TAB_LABELS = {daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', all: 'All'};

/** One topic's total: name, a bar scaled to the largest total, and the time. */
const BarRow = GObject.registerClass({
    GTypeName: 'FocusFlowBarRow',
}, class BarRow extends St.BoxLayout {
    _init() {
        super._init({style_class: 'focusflow-bar-row', x_expand: true});

        this._name = new St.Label({style_class: 'focusflow-bar-name', y_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._name);

        const track = new St.Widget({
            style_class: 'focusflow-bar-track',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // y_expand too: in a BinLayout an empty child otherwise gets 0 px height.
        this._fill = new St.Widget({
            style_class: 'focusflow-bar-fill',
            x_expand: true,
            y_expand: true,
            pivot_point: new Graphene.Point({x: 0, y: 0}),
        });
        track.add_child(this._fill);
        this.add_child(track);

        this._time = new St.Label({style_class: 'focusflow-bar-time', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._time);
    }

    set(row, maxSeconds) {
        // Deleted topics: grey italic name and a grey bar (no topic color left).
        this._name.text = row.name;
        this._time.text = formatDuration(row.seconds);
        this._fill.style = row.color ? `background-color: ${row.color};` : '';
        this._fill.scale_x = maxSeconds > 0 ? Math.max(0.02, row.seconds / maxSeconds) : 0;
        if (row.deleted)
            this.add_style_class_name('focusflow-bar-deleted');
        else
            this.remove_style_class_name('focusflow-bar-deleted');
    }
});

/**
 * Section 3 of the menu: Daily | Weekly | Monthly | All tabs, ‹ period ›
 * navigation, a summary line and one bar per topic with logged time.
 * The running timer's time so far is included.
 */
export const StatsView = GObject.registerClass({
    GTypeName: 'FocusFlowStatsView',
}, class StatsView extends St.BoxLayout {
    _init({settings, topics, sessions, engine, now = () => Date.now()}) {
        super._init({vertical: true, x_expand: true, style_class: 'focusflow-stats'});
        this._settings = settings;
        this._topics = topics;
        this._sessions = sessions;
        this._engine = engine;
        this._now = now;
        this._anchor = now();
        this._bars = [];

        const tabs = new St.BoxLayout({style_class: 'focusflow-tabs', x_align: Clutter.ActorAlign.CENTER});
        this._tabs = {};
        for (const period of Stats.PERIODS) {
            const tab = new St.Button({
                label: TAB_LABELS[period],
                style_class: 'focusflow-tab',
                toggle_mode: true,
                can_focus: true,
            });
            tab.connect('clicked', () => this.setPeriod(period));
            this._tabs[period] = tab;
            tabs.add_child(tab);
        }
        this.add_child(tabs);

        const nav = new St.BoxLayout({style_class: 'focusflow-stats-nav', x_expand: true});
        this._prev = this._navButton('go-previous-symbolic', 'Previous period', -1);
        this._label = new St.Label({
            style_class: 'focusflow-stats-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._next = this._navButton('go-next-symbolic', 'Next period', 1);
        nav.add_child(this._prev);
        nav.add_child(this._label);
        nav.add_child(this._next);
        this.add_child(nav);

        this._summary = new St.Label({style_class: 'focusflow-stats-summary', x_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._summary);

        this._barBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'focusflow-bars'});
        this.add_child(this._barBox);

        this._empty = new St.Label({
            text: 'No time logged for this period',
            style_class: 'focusflow-empty',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._empty);
    }

    get period() {
        const period = this._settings.get_string('stats-period');
        return Stats.PERIODS.includes(period) ? period : 'daily';
    }

    setPeriod(period) {
        if (period !== this.period)
            this._settings.set_string('stats-period', period);
        this._anchor = this._now();
        this.refresh();
    }

    /** Jumps back to the current day/week/month (call when the menu opens). */
    resetToNow() {
        this._anchor = this._now();
        this.refresh();
    }

    shift(delta) {
        const now = this._now();
        const weekStart = this._settings.get_string('week-start');
        if (delta > 0 && Stats.isCurrentPeriod(this.period, this._anchor, now, weekStart))
            return;
        this._anchor = Stats.shiftPeriod(this.period, this._anchor, delta);
        this.refresh();
    }

    refresh() {
        const period = this.period;
        const now = this._now();
        const weekStart = this._settings.get_string('week-start');
        const range = Stats.periodRange(period, this._anchor, weekStart, now);
        const isCurrent = Stats.isCurrentPeriod(period, this._anchor, now, weekStart);

        for (const [p, tab] of Object.entries(this._tabs))
            tab.checked = p === period;
        this._label.text = range.label;
        this._prev.visible = this._next.visible = period !== 'all';
        this._next.reactive = this._next.can_focus = !isCurrent;
        this._next.opacity = isCurrent ? 90 : 255;

        const sessions = this._sessions.sessions;
        const running = this._engine.running;
        const live = running ? segmentToSession(running, now, false, 'live') : null;
        const {rows, totalSeconds, completedCount} =
            Stats.aggregate(live ? [...sessions, live] : sessions, range, this._topics.all);

        this._summary.text = `Total ${formatDuration(totalSeconds)} · ${completedCount} completed`;
        this._summary.visible = this._barBox.visible = rows.length > 0;
        this._empty.visible = rows.length === 0;

        // Reuse bar rows so a refresh every second while a timer runs stays cheap.
        while (this._bars.length > rows.length)
            this._bars.pop().destroy();
        while (this._bars.length < rows.length) {
            const bar = new BarRow();
            this._bars.push(bar);
            this._barBox.add_child(bar);
        }
        const max = rows[0]?.seconds ?? 0;
        rows.forEach((row, i) => this._bars[i].set(row, max));
    }

    _navButton(iconName, accessibleName, delta) {
        const button = new St.Button({
            style_class: 'focusflow-button',
            accessible_name: accessibleName,
            can_focus: true,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        button.connect('clicked', () => this.shift(delta));
        return button;
    }
});
