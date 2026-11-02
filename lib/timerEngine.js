import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as TimerMath from './timerMath.js';

const TICK_MS = 1000;

// Runs the topic timers. At most one timer runs; starting another topic
// pauses it, and each topic keeps its own paused progress. Every time a
// timer stops running (pause, reset, switch, finish or topic deleted) the
// time it actually ran is logged as a session.
//
// State lives in the 'timers' GSettings key, so a shell restart, logout or
// disable/enable picks up where it left off. The 1 s tick only redraws and
// checks for the finish against the wall clock, so time spent suspended is
// counted correctly.
//
// Signals:
//   changed  — any timer started, paused, resumed, reset or finished
//   tick     — once a second while a timer runs (for countdown labels)
//   finished — a timer reached zero; carries the logged session and
//              whether it was noticed late (after suspend or shell restart)
export const TimerEngine = GObject.registerClass({
    Signals: {
        'changed': {},
        'tick': {},
        'finished': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_BOOLEAN]},
    },
}, class TimerEngine extends GObject.Object {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {TopicsStore} params.topics
     * @param {SessionStore} params.sessions
     * @param {() => number} [params.now] - clock, injectable for tests
     */
    constructor({settings, topics, sessions, now = () => Date.now()}) {
        super();
        this._settings = settings;
        this._topics = topics;
        this._sessions = sessions;
        this._now = now;
        this._tickId = 0;
        this._timers = TimerMath.parseTimers(settings.get_string('timers'));
        this._topicsChangedId = topics.connectChanged(list => this._onTopicsChanged(list));
        this._onTopicsChanged(topics.all);
        this._syncTick();
    }

    /**
     * Finishes the running timer if it has already reached zero, e.g. it ended
     * while the shell was not running. Call once after connecting to
     * 'finished'; afterwards the tick does this. Returns true if it finished one.
     */
    checkFinished() {
        return this._checkFinished();
    }

    /** Snapshot of all timers keyed by topic id; do not mutate. */
    get timers() {
        return this._timers;
    }

    get running() {
        return TimerMath.runningTimer(this._timers);
    }

    getTimer(topicId) {
        return this._timers[topicId] ?? null;
    }

    remainingMs(topicId) {
        const timer = this.getTimer(topicId);
        return timer ? TimerMath.remainingMs(timer, this._now()) : null;
    }

    progress(topicId) {
        const timer = this.getTimer(topicId);
        return timer ? TimerMath.progress(timer, this._now()) : 0;
    }

    /** Starts a topic, or resumes it if paused. Pauses whatever else is running. */
    start(topicId) {
        const topic = this._topics.find(topicId);
        if (!topic)
            throw new Error(`No topic with id ${topicId}`);
        this._checkFinished();

        const now = this._now();
        const current = this.running;
        if (current?.topicId === topicId)
            return;
        if (current)
            this._stopRunning(current, now);

        const existing = this.getTimer(topicId);
        this._timers = {
            ...this._timers,
            [topicId]: existing ? TimerMath.resumeTimer(existing, now) : TimerMath.startTimer(topic, now),
        };
        this._settings.set_string('last-topic-id', topicId);
        this._commit();
    }

    /** Pauses the running timer (if it belongs to `topicId`, when given). */
    pause(topicId = null) {
        this._checkFinished();
        const current = this.running;
        if (!current || (topicId && current.topicId !== topicId))
            return;
        this._stopRunning(current, this._now());
        this._commit();
    }

    /** Clears a topic's timer; a running segment is logged first. */
    reset(topicId) {
        this._checkFinished();
        const timer = this.getTimer(topicId);
        if (!timer)
            return;
        if (timer.status === 'running')
            this._log(timer, this._now(), false);
        this._remove(topicId);
        this._commit();
    }

    /** Drops a topic's timer without logging anything (its history is being deleted). */
    forget(topicId) {
        if (!this.getTimer(topicId))
            return;
        this._remove(topicId);
        this._commit();
    }

    /**
     * Keyboard shortcut action: pause the running timer, else resume the most
     * recently paused one, else start the last used topic.
     */
    toggle() {
        this._checkFinished();
        if (this.running) {
            this.pause();
            return;
        }
        const paused = TimerMath.lastPausedTimer(this._timers);
        const lastId = this._settings.get_string('last-topic-id');
        const topicId = paused?.topicId ?? (this._topics.find(lastId) ? lastId : this._topics.visible[0]?.id);
        if (topicId)
            this.start(topicId);
    }

    destroy() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._topicsChangedId) {
            this._topics.disconnect(this._topicsChangedId);
            this._topicsChangedId = 0;
        }
    }

    _stopRunning(timer, now) {
        this._log(timer, now, false);
        this._timers = {...this._timers, [timer.topicId]: TimerMath.pauseTimer(timer, now)};
    }

    _remove(topicId) {
        const {[topicId]: _removed, ...rest} = this._timers;
        this._timers = rest;
    }

    _log(timer, now, completed) {
        const session = TimerMath.segmentToSession(timer, now, completed, GLib.uuid_string_random());
        if (session) {
            this._sessions.append(session)
                .catch(e => console.error(`FocusFlow: saving session failed: ${e.message}`));
        }
        return session;
    }

    /** Finishes the running timer if it has reached zero; returns true if it did. */
    _checkFinished() {
        const timer = this.running;
        const now = this._now();
        if (!timer || !TimerMath.isFinished(timer, now))
            return false;

        // Noticed more than a couple of ticks after the end: suspend or shell restart.
        const late = now - TimerMath.finishAt(timer) > 2 * TICK_MS;
        const session = this._log(timer, now, true);
        this._remove(timer.topicId);
        this._settings.set_string('last-topic-id', timer.topicId);
        this._commit();
        this.emit('finished', session, late);
        return true;
    }

    _onTopicsChanged(topics) {
        const ids = new Set(topics.map(t => t.id));
        const gone = Object.keys(this._timers).filter(id => !ids.has(id));
        if (gone.length === 0)
            return;
        const now = this._now();
        for (const id of gone) {
            if (this._timers[id].status === 'running')
                this._log(this._timers[id], now, false);
            this._remove(id);
        }
        this._commit();
    }

    _commit() {
        this._settings.set_string('timers', JSON.stringify(this._timers));
        this._syncTick();
        this.emit('changed');
    }

    _syncTick() {
        if (this.running && !this._tickId) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                this._inTick = true;
                try {
                    if (!this._checkFinished())
                        this.emit('tick');
                } finally {
                    this._inTick = false;
                }
                // A finish (or a 'finished' handler) may have replaced or stopped this source.
                return this._tickId === id ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
            });
            this._tickId = id;
        } else if (!this.running && this._tickId) {
            // Inside the callback, returning SOURCE_REMOVE removes it.
            if (!this._inTick)
                GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }
});
