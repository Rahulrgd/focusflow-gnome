// Pure topic helpers: no Shell or GTK imports, so they also run under plain gjs (tests/run.js).
// Every function returns a new array and leaves its input untouched.

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 600;
export const MAX_GOAL_MINUTES = 1440;
export const MAX_NAME_LENGTH = 40;

export const DEFAULT_TOPICS = [
    {name: 'Study', minutes: 45, color: '#3584e4'},
    {name: 'Break', minutes: 5, color: '#33d17a'},
    {name: 'Gaming', minutes: 30, color: '#9141ac'},
    {name: 'YouTube', minutes: 15, color: '#e01b24'},
];

const COLOR_RE = /^#[0-9a-f]{6}$/;

export class TopicError extends Error {}

function isIntIn(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
}

function normalize(fields) {
    const out = {};
    if ('name' in fields)
        out.name = String(fields.name ?? '').trim();
    if ('minutes' in fields)
        out.minutes = Number(fields.minutes);
    if ('color' in fields)
        out.color = String(fields.color ?? '').toLowerCase();
    if ('hidden' in fields)
        out.hidden = Boolean(fields.hidden);
    if ('dailyGoalMinutes' in fields) {
        const goal = fields.dailyGoalMinutes;
        out.dailyGoalMinutes = goal === null || goal === '' || goal === 0 ? null : Number(goal);
    }
    return out;
}

/**
 * Returns a list of problems with `topic`; empty when it is valid.
 * `topics` is the list it lives in, used for the duplicate-name check.
 */
export function validateTopic(topic, topics) {
    const errors = [];
    if (typeof topic.name !== 'string' || topic.name === '')
        errors.push('Name is required');
    else if (topic.name.length > MAX_NAME_LENGTH)
        errors.push(`Name must be at most ${MAX_NAME_LENGTH} characters`);
    else if (topics.some(t => t.id !== topic.id && t.name.toLowerCase() === topic.name.toLowerCase()))
        errors.push(`A topic named "${topic.name}" already exists`);

    if (!isIntIn(topic.minutes, MIN_MINUTES, MAX_MINUTES))
        errors.push(`Minutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}`);
    if (typeof topic.color !== 'string' || !COLOR_RE.test(topic.color))
        errors.push('Color must look like #3584e4');
    if (topic.dailyGoalMinutes !== null && !isIntIn(topic.dailyGoalMinutes, 1, MAX_GOAL_MINUTES))
        errors.push(`Daily goal must be empty or a whole number from 1 to ${MAX_GOAL_MINUTES}`);
    return errors;
}

function check(topic, topics) {
    const errors = validateTopic(topic, topics);
    if (errors.length)
        throw new TopicError(errors.join('. '));
}

function findOrThrow(topics, id) {
    const topic = topics.find(t => t.id === id);
    if (!topic)
        throw new TopicError(`No topic with id ${id}`);
    return topic;
}

/** Sorts by `order` and renumbers it 0, 1, 2, ... */
function renumber(topics) {
    return sortTopics(topics).map((t, i) => t.order === i ? t : {...t, order: i});
}

export function sortTopics(topics) {
    return [...topics].sort((a, b) => a.order - b.order);
}

export function visibleTopics(topics) {
    return sortTopics(topics).filter(t => !t.hidden);
}

export function findTopic(topics, id) {
    return topics.find(t => t.id === id) ?? null;
}

export function addTopic(topics, fields, id) {
    const topic = {
        id,
        name: '',
        minutes: 25,
        color: DEFAULT_TOPICS[topics.length % DEFAULT_TOPICS.length].color,
        hidden: false,
        dailyGoalMinutes: null,
        ...normalize(fields),
        order: topics.length ? Math.max(...topics.map(t => t.order)) + 1 : 0,
    };
    check(topic, topics);
    return [...topics, topic];
}

export function updateTopic(topics, id, changes) {
    const topic = {...findOrThrow(topics, id), ...normalize(changes)};
    check(topic, topics);
    return topics.map(t => t.id === id ? topic : t);
}

export function deleteTopic(topics, id) {
    findOrThrow(topics, id);
    return renumber(topics.filter(t => t.id !== id));
}

export function toggleHidden(topics, id) {
    return updateTopic(topics, id, {hidden: !findOrThrow(topics, id).hidden});
}

/**
 * Puts topics in the order of `ids`. Topics missing from `ids` keep their
 * relative order after the listed ones; unknown ids are ignored.
 */
export function reorderTopics(topics, ids) {
    const rank = new Map(ids.map((id, i) => [id, i]));
    const listed = topics.filter(t => rank.has(t.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const rest = sortTopics(topics.filter(t => !rank.has(t.id)));
    return [...listed, ...rest].map((t, i) => t.order === i ? t : {...t, order: i});
}

/** Moves a topic up (delta < 0) or down (delta > 0); clamps at the ends. */
export function moveTopic(topics, id, delta) {
    const ids = sortTopics(topics).map(t => t.id);
    const from = ids.indexOf(id);
    if (from < 0)
        throw new TopicError(`No topic with id ${id}`);
    const to = Math.min(Math.max(from + delta, 0), ids.length - 1);
    ids.splice(to, 0, ...ids.splice(from, 1));
    return reorderTopics(topics, ids);
}

/** Parses the stored JSON, dropping anything malformed instead of throwing. */
export function parseTopics(json) {
    let data;
    try {
        data = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(data))
        return [];

    const topics = [];
    data.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '')
            return;
        // Fixed field order; unknown fields are dropped.
        const topic = {
            id: raw.id,
            name: raw.name,
            minutes: raw.minutes,
            color: raw.color,
            hidden: raw.hidden === true,
            dailyGoalMinutes: raw.dailyGoalMinutes ?? null,
            order: Number.isFinite(raw.order) ? raw.order : i,
        };
        if (validateTopic(topic, topics).length === 0)
            topics.push(topic);
    });
    return renumber(topics);
}

export function seedTopics(newId) {
    return DEFAULT_TOPICS.reduce((list, t) => addTopic(list, t, newId()), []);
}
