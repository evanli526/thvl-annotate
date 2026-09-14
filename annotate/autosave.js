/* Per-video, revision-aware save queue. Shared by the page and Node regression tests. */
(function (root) {
  class VersionedSaver {
    constructor({send, storage, prefix, onState = () => {}, delay = 1000}) {
      this.send = send; this.storage = storage; this.prefix = prefix;
      this.onState = onState; this.delay = delay; this.states = new Map();
    }
    load(id, revision = 0) {
      if (this.states.get(id)?.promise) throw new Error('save in progress');
      this.states.set(id, {revision, version: 0, saved: 0, record: null, promise: null, timer: null, conflict: false});
    }
    dirty(id) { const s = this.states.get(id); return !!s && s.version > s.saved; }
    anyDirty() { return [...this.states.keys()].some(id => this.dirty(id)); }
    backup(id, s) {
      try {
        this.storage.setItem(this.prefix + id, JSON.stringify({record: s.record, baseRevision: s.revision}));
      } catch (error) {
        // Local quota/privacy failures must not prevent sending the in-memory draft.
        this.onState(id, 'backup_error', error);
      }
    }
    mark(id, record) {
      const s = this.states.get(id);
      if (!s) throw new Error('video not loaded');
      s.record = JSON.parse(JSON.stringify(record)); s.version++;
      this.backup(id, s); this.onState(id, 'dirty');
      clearTimeout(s.timer);
      if (!s.conflict) s.timer = setTimeout(() => this.flush(id), this.delay);
    }
    flush(id) {
      const s = this.states.get(id);
      if (!s || !this.dirty(id)) return Promise.resolve(true);
      if (s.conflict) return Promise.resolve(false);
      if (s.promise) return s.promise;
      clearTimeout(s.timer);
      s.promise = this._drain(id, s).finally(() => { s.promise = null; });
      return s.promise;
    }
    async _drain(id, s) {
      while (s.version > s.saved) {
        const version = s.version, record = JSON.parse(JSON.stringify(s.record));
        this.onState(id, 'saving');
        try {
          const data = await this.send(record, s.revision);
          s.revision = data.revision; s.saved = version;
          if (s.version === version) {
            try { this.storage.removeItem(this.prefix + id); }
            catch (error) { this.onState(id, 'backup_error', error); }
          }
          else this.backup(id, s);
          this.onState(id, this.dirty(id) ? 'dirty' : 'saved', data, record);
        } catch (error) {
          s.conflict = error.status === 409;
          this.onState(id, s.conflict ? 'conflict' : 'error', error);
          // Validation errors need editing; conflicts need an explicit reload/reconciliation.
          if (!s.conflict && error.status !== 400) s.timer = setTimeout(() => this.flush(id), 15000);
          return false;
        }
      }
      return true;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = VersionedSaver;
  else root.VersionedSaver = VersionedSaver;
})(typeof globalThis !== 'undefined' ? globalThis : this);
