// Pure timer helpers: no Shell or GTK imports, so they also run under plain gjs (tests/run.js).
//
// A timer is based on wall-clock timestamps, never on counting ticks:
//   running: {topicId, topicName, status: 'running', durationMs, startedAt, remainingMsAtStart}
//   paused:  {topicId, topicName, status: 'paused',  durationMs, remainingMs, pausedAt}
// `durationMs` is fixed when the timer starts, so editing a topic's minutes
// only affects the next start.

/** Sessions shorter than this (e.g. a play/pause misclick) are not logged. */
export const MIN_SESSION_SECONDS = 1;

function elapsedMs(timer, now) {
    // Clamp so a clock that jumps backwards never adds time.
    return Math.max(0, now - timer.startedAt);
}

export function remainingMs(timer, now) {
    if (timer.status === 'paused')
        return timer.remainingMs;
    return Math.max(0, timer.remainingMsAtStart - elapsedMs(timer, now));
}

/** 0 when just started, 1 when finished. */
export function progress(timer, now) {
    return timer.durationMs > 0 ? 1 - remainingMs(timer, now) / timer.durationMs : 1;
}

/** Wall-clock time the running timer reaches zero, or null when paused. */
export function finishAt(timer) {
    return timer.status === 'running' ? timer.startedAt + timer.remainingMsAtStart : null;
}

export function isFinished(timer, now) {
    return timer.status === 'running' && now >= finishAt(timer);
}

export function startTimer(topic, now) {
    const durationMs = topic.minutes * 60_000;
    return {
        topicId: topic.id,
        topicName: topic.name,
        status: 'running',
        durationMs,
        startedAt: now,
        remainingMsAtStart: durationMs,
    };
}

export function pauseTimer(timer, now) {
    const {startedAt: _s, remainingMsAtStart: _r, ...rest} = timer;
    return {...rest, status: 'paused', remainingMs: remainingMs(timer, now), pausedAt: now};
}

export function resumeTimer(timer, now) {
    const {remainingMs: remaining, pausedAt: _p, ...rest} = timer;
    return {...rest, status: 'running', startedAt: now, remainingMsAtStart: remaining};
}

/**
 * The session for the running segment of `timer` (from its last start or
 * resume until `now`), or null if it is too short to log. A completed
 * segment ends exactly at finishAt(), even if noticed later (suspend, shell
 * restart).
 */
export function segmentToSession(timer, now, completed, id) {
    if (timer.status !== 'running')
        return null;
    const start = timer.startedAt;
    const end = completed ? finishAt(timer) : Math.min(Math.max(now, start), finishAt(timer));
    const seconds = Math.round((end - start) / 1000);
    if (seconds < MIN_SESSION_SECONDS && !completed)
        return null;
    return {id, topicId: timer.topicId, topicName: timer.topicName, start, end, seconds, completed};
}

function isValidTimer(t) {
    if (!t || typeof t !== 'object' || typeof t.topicId !== 'string' || t.topicId === '' ||
        typeof t.topicName !== 'string' || !(Number.isFinite(t.durationMs) && t.durationMs > 0))
        return false;
    if (t.status === 'running')
        return Number.isFinite(t.startedAt) && Number.isFinite(t.remainingMsAtStart) && t.remainingMsAtStart >= 0;
    if (t.status === 'paused')
        return Number.isFinite(t.remainingMs) && t.remainingMs >= 0 && Number.isFinite(t.pausedAt);
    return false;
}

/**
 * Parses the stored `{topicId: timer}` map, dropping malformed entries.
 * If several timers claim to be running, only the most recently started one
 * stays running; the others are paused at the moment it started.
 */
export function parseTimers(json) {
    let data;
    try {
        data = JSON.parse(json);
    } catch {
        return {};
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return {};

    const timers = {};
    for (const [id, t] of Object.entries(data)) {
        if (isValidTimer(t) && t.topicId === id)
            timers[id] = t;
    }
    const running = Object.values(timers).filter(t => t.status === 'running')
        .sort((a, b) => b.startedAt - a.startedAt);
    for (const t of running.slice(1))
        timers[t.topicId] = pauseTimer(t, running[0].startedAt);
    return timers;
}

export function runningTimer(timers) {
    return Object.values(timers).find(t => t.status === 'running') ?? null;
}

/** The most recently paused timer, or null. */
export function lastPausedTimer(timers) {
    return Object.values(timers).filter(t => t.status === 'paused')
        .sort((a, b) => b.pausedAt - a.pausedAt)[0] ?? null;
}
