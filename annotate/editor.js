/* Display times in minutes:seconds; persisted records continue to use seconds. */
(function(root) {
  const formatTime = seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const ticks = Math.round(seconds * 10);
    return String(Math.floor(ticks / 600)).padStart(2, '0') + ':' + ((ticks % 600) / 10).toFixed(1).padStart(4, '0');
  };
  const parseTime = value => {
    const match = /^(\d+):([0-5]?\d(?:\.\d{1,6})?)$/.exec(String(value).trim());
    if (!match) return null;
    const seconds = Number(match[1]) * 60 + Number(match[2]);
    return Number.isFinite(seconds) ? seconds : null;
  };
  const draftSegments = (segments, saved) => structuredClone(segments).map(s => saved ? s : ({...s, rationale:'', needs_review:false}));
  const api = {formatTime, parseTime, draftSegments};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AnnotationEditor = api;
})(globalThis);
