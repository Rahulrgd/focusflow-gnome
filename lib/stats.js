// Pure stats helpers: no Shell or GTK imports, so they also run under plain gjs (tests/run.js).
// All ranges are half-open [start, end) in epoch ms, built from local calendar
// dates (never "+ 24 h") so they stay correct across daylight-saving changes.

export const PERIODS = ['daily', 'weekly', 'monthly', 'all'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = MONTHS.map(m => m.slice(0, 3));
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function startOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfWeek(ms, weekStart) {
    const day = startOfDay(ms);
    const first = weekStart === 'sun' ? 0 : 1;
    return addDays(day, -((day.getDay() - first + 7) % 7));
}

function dayMonth(date) {
    return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`;
}

function sameRange(a, b) {
    return a.start === b.start && a.end === b.end;
}

/**
 * The period of `type` that contains `anchor`, with a label relative to `now`:
 * "Today", "This week", "October 2026", ...
 */
export function periodRange(type, anchor, weekStart = 'mon', now = anchor) {
    switch (type) {
    case 'daily': {
        const start = startOfDay(anchor);
        const range = {start: start.getTime(), end: addDays(start, 1).getTime()};
        const today = startOfDay(now);
        if (start.getTime() === today.getTime())
            range.label = 'Today';
        else if (start.getTime() === addDays(today, -1).getTime())
            range.label = 'Yesterday';
        else
            range.label = `${SHORT_DAYS[start.getDay()]}, ${dayMonth(start)}${start.getFullYear() === today.getFullYear() ? '' : ` ${start.getFullYear()}`}`;
        return range;
    }
    case 'weekly': {
        const start = startOfWeek(anchor, weekStart);
        const last = addDays(start, 6);
        const range = {start: start.getTime(), end: addDays(start, 7).getTime()};
        const thisWeek = startOfWeek(now, weekStart);
        if (start.getTime() === thisWeek.getTime())
            range.label = 'This week';
        else if (start.getTime() === addDays(thisWeek, -7).getTime())
            range.label = 'Last week';
        else
            range.label = `${dayMonth(start)} – ${dayMonth(last)}${last.getFullYear() === new Date(now).getFullYear() ? '' : ` ${last.getFullYear()}`}`;
        return range;
    }
    case 'monthly': {
        const a = new Date(anchor);
        const start = new Date(a.getFullYear(), a.getMonth(), 1);
        const n = new Date(now);
        return {
            start: start.getTime(),
            end: new Date(a.getFullYear(), a.getMonth() + 1, 1).getTime(),
            label: a.getFullYear() === n.getFullYear() && a.getMonth() === n.getMonth()
                ? 'This month'
                : `${MONTHS[a.getMonth()]} ${a.getFullYear()}`,
        };
    }
    case 'all':
        return {start: -Infinity, end: Infinity, label: 'All time'};
    default:
        throw new Error(`Unknown period: ${type}`);
    }
}

/** Moves `anchor` by `delta` periods (days, weeks or months). */
export function shiftPeriod(type, anchor, delta) {
    const d = new Date(anchor);
    switch (type) {
    case 'daily':
        return addDays(startOfDay(anchor), delta).getTime();
    case 'weekly':
        return addDays(startOfDay(anchor), 7 * delta).getTime();
    case 'monthly':
        // Day 1, so 31 Jan + 1 month is February, not 3 March.
        return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime();
    default:
        return anchor;
    }
}

/** Whether the period containing `anchor` is the one containing `now` (no "next" then). */
export function isCurrentPeriod(type, anchor, now, weekStart = 'mon') {
    return sameRange(periodRange(type, anchor, weekStart), periodRange(type, now, weekStart));
}

/**
 * Totals per topic for sessions that started inside `range`.
 * Topics that no longer exist keep their last logged name and are marked
 * `deleted`. Rows are sorted by time, largest first; topics with no time are
 * left out.
 *
 * @returns {{rows: {topicId, name, color, seconds, deleted}[], totalSeconds, completedCount}}
 */
export function aggregate(sessions, range, topics) {
    const byId = new Map(topics.map(t => [t.id, t]));
    const totals = new Map();
    let totalSeconds = 0;
    let completedCount = 0;

    for (const s of sessions) {
        if (s.start < range.start || s.start >= range.end)
            continue;
        totalSeconds += s.seconds;
        if (s.completed)
            completedCount++;
        const row = totals.get(s.topicId);
        if (row) {
            row.seconds += s.seconds;
            row.lastName = s.end >= row.lastEnd ? s.topicName : row.lastName;
            row.lastEnd = Math.max(row.lastEnd, s.end);
        } else {
            totals.set(s.topicId, {seconds: s.seconds, lastName: s.topicName, lastEnd: s.end});
        }
    }

    const rows = [...totals.entries()]
        .filter(([, t]) => t.seconds > 0)
        .map(([topicId, t]) => {
            const topic = byId.get(topicId);
            return {
                topicId,
                name: topic?.name ?? t.lastName,
                color: topic?.color ?? null,
                seconds: t.seconds,
                deleted: !topic,
            };
        })
        .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
    return {rows, totalSeconds, completedCount};
}
