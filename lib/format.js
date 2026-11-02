// Pure display formatting: no Shell or GTK imports, so they also run under plain gjs (tests/run.js).

const pad = n => String(n).padStart(2, '0');

/**
 * Countdown text: "45:00", "04:59", "1:30:00". Rounds up, so a timer shows
 * its full length when started and reads "00:00" only once it is done.
 */
export function formatClock(ms) {
    const total = Math.ceil(Math.max(0, ms) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Total time text: "2h 15m", "45m", "2h", "30s". */
export function formatDuration(seconds) {
    const total = Math.round(Math.max(0, seconds));
    if (total < 60)
        return `${total}s`;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (!h)
        return `${m}m`;
    return m ? `${h}h ${m}m` : `${h}h`;
}
