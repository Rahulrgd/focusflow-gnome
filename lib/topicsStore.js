import GLib from 'gi://GLib';

import * as Model from './topicsModel.js';

const newId = () => GLib.uuid_string_random();

// Topic list stored as JSON in the 'topics' GSettings key, so the shell and
// the prefs process share it and both see changes immediately.
// Write methods throw Model.TopicError on invalid input.
export class TopicsStore {
    constructor(settings) {
        this._settings = settings;
    }

    get all() {
        return Model.parseTopics(this._settings.get_string('topics'));
    }

    get sorted() {
        return Model.sortTopics(this.all);
    }

    get visible() {
        return Model.visibleTopics(this.all);
    }

    find(id) {
        return Model.findTopic(this.all, id);
    }

    /** Adds the default topics once per install; returns true if it did. */
    seedIfNeeded() {
        if (this._settings.get_boolean('seeded'))
            return false;
        // Topics may already exist, e.g. from a restored dconf backup.
        if (this.all.length === 0)
            this._save(Model.seedTopics(newId));
        this._settings.set_boolean('seeded', true);
        return true;
    }

    add(fields) {
        const list = Model.addTopic(this.all, fields, newId());
        this._save(list);
        return list.at(-1);
    }

    update(id, changes) {
        this._save(Model.updateTopic(this.all, id, changes));
    }

    delete(id) {
        this._save(Model.deleteTopic(this.all, id));
    }

    toggleHidden(id) {
        this._save(Model.toggleHidden(this.all, id));
    }

    reorder(ids) {
        this._save(Model.reorderTopics(this.all, ids));
    }

    move(id, delta) {
        this._save(Model.moveTopic(this.all, id, delta));
    }

    replaceAll(topics) {
        this._save(topics);
    }

    /** Calls `callback(topics)` whenever the list changes; returns a handler id. */
    connectChanged(callback) {
        return this._settings.connect('changed::topics', () => callback(this.all));
    }

    disconnect(id) {
        this._settings.disconnect(id);
    }

    _save(topics) {
        this._settings.set_string('topics', JSON.stringify(Model.sortTopics(topics)));
    }
}
