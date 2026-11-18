// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Shared auto-refresh for revenue screens. Staff never press Refresh: while the
// tab is visible the screen's own load function re-runs on an interval, right
// after the tab is seen again or the window regains focus, and after a save
// elsewhere succeeds. A tick is skipped while the person is typing or has
// unsaved edits inside the host (a focused field, a form the draft code marks
// dirty through isDirty or dirtyForms, or values that no longer match), while a
// request is already in flight, or once the host leaves the page. Errors only
// widen the delay (doubling up to five minutes) and never raise a popup; the
// host header carries a small muted "Updated just now / 2 min ago" line
// instead. Content is replaced only when the data actually changed, and a
// repaint restores scroll and focus, so nothing flashes, jumps or moves the
// cursor. load() may return markup, {markup}, undefined or null to keep the
// screen's own in-place update, or a stop token from autoRefreshStop() to
// unregister (a claim that reached its final status, a closed screen).
const autoRefreshRuns = new Map();
const autoRefreshHostKeys = typeof WeakMap === 'function' ? new WeakMap() : null;
const autoRefreshStopToken = Symbol('autoRefreshStop');
let autoRefreshBound = false;
let autoRefreshSaving = 0;

function autoRefreshStop(){ return autoRefreshStopToken; }
function autoRefreshUniq(){return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + ':' + String(Math.random()).slice(2);}
function autoRefreshFormDirty(form){
  if (form.dataset && form.dataset.autorefreshDirty === 'true') return true;
  if (form.dataset && form.dataset.dirty === 'true') return true;
  if (form.classList && typeof form.classList.contains === 'function' && form.classList.contains('dirty')) return true;
  if (typeof form.isDirty === 'function') { try { if (form.isDirty()) return true; } catch {} }
  const fields = form.elements ? Array.from(form.elements) : [];
  for (const field of fields) {
    if (!field || !field.name) continue;
    if (field.type === 'file' && field.files && field.files.length) return true;
    if (typeof field.value === 'string' && field.value !== (field.defaultValue ?? '')) return true;
    if (typeof field.defaultChecked === 'boolean' && !!field.checked !== field.defaultChecked) return true;
  }
  return false;
}
// True when someone is mid-edit inside the host. Failing closed is correct: an
// unexpected error must never overwrite what the person is typing.
function autoRefreshEditing(host){
  try {
    const doc = typeof document !== 'undefined' ? document : null;
    const active = doc ? doc.activeElement : null;
    if (active && active !== doc.body && typeof host.contains === 'function' && host.contains(active)
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return true;
    for (const form of Array.from(host.querySelectorAll?.('form') || [])) {
      if (autoRefreshFormDirty(form)) return true;
    }
    // The draft code keeps its unsaved edits in maps outside the DOM. A screen
    // passes them in through host.dirtyForms or options.editing.
    for (const test of (host.dirtyForms || [])) { try { if (typeof test === 'function' ? test() : !!test) return true; } catch { return true; } }
    if (typeof host.isDirty === 'function') { try { if (host.isDirty()) return true; } catch { return true; } }
    if (entryEditing(host)) return true;
  } catch { return true; }
  return false;
}
function entryEditing(host){
  const check = host.autoRefreshEditing;
  if (typeof check !== 'function') return false;
  try { return !!check(); } catch { return true; }
}
function autoRefreshStamp(ms){
  const mins = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  return mins < 1 ? 'Updated just now' : mins === 1 ? 'Updated 1 min ago' : `Updated ${mins} min ago`;
}
// Repaint only what changed: identical content is left alone entirely, and a
// repaint restores scroll positions and focus so the page never jumps or flashes.
function autoRefreshMark(value){
  if (value && typeof value === 'object' && !Array.isArray(value) && 'markup' in value) return value.markup;
  return typeof value === 'string' ? value : null;
}
function autoRefreshRepaint(entry, value){
  const host = entry.host;
  const mark = autoRefreshMark(value);
  if (mark === null || JSON.stringify(mark) === entry.fingerprint) {
    // Data unchanged (or the screen updates itself in place): no DOM write.
    entry.lastUpdated = Date.now();
    entry.attempt = 0;
    if (entry.status) entry.status.textContent = autoRefreshStamp(entry.lastUpdated);
    return false;
  }
  const scrollable = [];
  if (host.scrollHeight > host.clientHeight) scrollable.push([host, host.scrollTop, host.scrollLeft]);
  for (const node of Array.from(host.querySelectorAll?.('*') || [])) {
    if (node.scrollHeight > node.clientHeight + 1) { try { scrollable.push([node, node.scrollTop, node.scrollLeft]); } catch {} }
  }
  const doc = typeof document !== 'undefined' ? document : null;
  const focus = doc && doc.activeElement && typeof host.contains === 'function' && host.contains(doc.activeElement) ? doc.activeElement : null;
  const caret = focus && typeof focus.selectionStart === 'number' ? [focus.selectionStart, focus.selectionEnd] : null;
  host.innerHTML = String(mark);
  for (const [node, top, left] of scrollable) { try { node.scrollTop = top; node.scrollLeft = left; } catch {} }
  if (focus && focus.isConnected !== false) {
    try { focus.focus({preventScroll: true}); } catch { try { focus.focus(); } catch {} }
    if (caret && typeof focus.setSelectionRange === 'function') { try { focus.setSelectionRange(caret[0], caret[1]); } catch {} }
  }
  entry.fingerprint = JSON.stringify(mark);
  entry.lastUpdated = Date.now();
  entry.attempt = 0;
  if (entry.status) entry.status.textContent = autoRefreshStamp(entry.lastUpdated);
  return true;
}
async function autoRefreshTick(entry, immediate = false){
  if (entry.unregistered || typeof entry.load !== 'function') return;
  // A removed host never starts work; the in-flight request finishes first and
  // unregisters on its way out, so nothing is orphaned.
  if (!entry.host || entry.host.isConnected === false) { if (!entry.inFlight) autoRefreshUnregister(entry.key); return; }
  if (entry.inFlight) return;
  const doc = typeof document !== 'undefined' ? document : null;
  if (!immediate && (doc && doc.visibilityState === 'hidden')) return;
  // A refresh right after a save must not cut into something being typed, and
  // must not fire while the tab is hidden; only the interval waits for quiet.
  if (autoRefreshEditing(entry.host)) return;
  if (immediate && (doc && doc.visibilityState === 'hidden')) return;
  entry.inFlight = true;
  try {
    const value = await entry.load();
    if (value === autoRefreshStopToken) { autoRefreshUnregister(entry.key); return; }
    if (!entry.unregistered && entry.host.isConnected !== false) autoRefreshRepaint(entry, value);
    else if (!entry.unregistered) { autoRefreshUnregister(entry.key); return; }
  } catch {
    // Never a popup: the update line keeps the last good time and the wait grows.
    entry.attempt = Math.min(entry.attempt + 1, 5);
  } finally {
    entry.inFlight = false;
    if (!entry.unregistered) autoRefreshSchedule(entry);
  }
}
function autoRefreshSchedule(entry){
  if (entry.unregistered) return;
  // Backoff doubles from the normal wait, once for the immediate refresh too,
  // and never grows past five minutes.
  const gap = entry.attempt ? Math.min(entry.everyMs * Math.pow(2, entry.attempt), 300000) : entry.everyMs;
  entry.timer = setTimeout(() => void autoRefreshTick(entry), gap);
}
function autoRefreshHost(id){
  if (!id) return null;
  if (typeof id === 'object') return typeof id.querySelectorAll === 'function' ? id : null;
  return typeof $ === 'function' ? $(id) : (typeof document !== 'undefined' ? document.getElementById(id) : null);
}
function autoRefreshLine(){
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.createElement) return null;
  const line = doc.createElement('small');
  line.className = 'muted auto-refresh-updated';
  line.setAttribute('role', 'status');
  line.textContent = 'Updates automatically';
  return line;
}
function autoRefreshHead(host){
  const doc = typeof document !== 'undefined' ? document : null;
  const query = selector => typeof host.querySelector === 'function' ? host.querySelector(selector) : null;
  let head = query(':scope > .section-head') || query(':scope > * > .section-head');
  if (!head && typeof host.querySelectorAll === 'function') {
    // A plain scan for the class keeps stubbed DOM nodes (and unusual markup)
    // working; ':scope' is a CSS feature, not a contract.
    head = Array.from(host.querySelectorAll('*')).find(node => node.className && String(node.className).split(' ').includes('section-head')) || null;
  }
  if (!head && host.parentElement && typeof host.parentElement.querySelector === 'function'
    && (doc && doc.contains ? doc.contains(host.parentElement) : host.parentElement.isConnected !== false)
    && host.parentElement !== (doc ? doc.body : null)) {
    const outer = host.parentElement.querySelector(':scope > .section-head');
    if (outer) head = outer;
  }
  if (!head) {
    head = doc.createElement('div');
    head.className = 'section-head auto-refresh-head';
    host.insertBefore(head, host.firstChild);
  }
  return typeof head.appendChild === 'function' ? head : null;
}
function autoRefreshRefreshAll(immediate){
  for (const entry of autoRefreshRuns.values()) void autoRefreshTick(entry, immediate);
}
function autoRefreshSettle(){
  autoRefreshSaving = Math.max(0, autoRefreshSaving - 1);
  if (autoRefreshSaving === 0) autoRefreshRefreshAll(true);
}
function autoRefreshBump(){
  // A form save anywhere starts a quiet window. Successful saves call
  // autoRefreshTickSoon() (through api()) so the pending refresh releases as
  // soon as the save is done; a failed or unusually slow save still releases
  // on the timeout below, so the screens never stop updating.
  autoRefreshSaving++;
  setTimeout(autoRefreshSettle, 2000);
}
function autoRefreshBind(){
  if (autoRefreshBound || typeof document === 'undefined' || !document.addEventListener) return;
  autoRefreshBound = true;
  document.addEventListener('visibilitychange', () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    autoRefreshRefreshAll(true);
  });
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', () => autoRefreshRefreshAll(true));
  }
  // Any form save starts a quiet window; successful saves also call
  // autoRefreshSaved() so the result shows as soon as it is safe.
  document.addEventListener('submit', () => autoRefreshBump(), true);
}

function registerAutoRefresh(hostElementOrId, options = {}){
  autoRefreshBind();
  const host = autoRefreshHost(hostElementOrId);
  if (!host || typeof options.load !== 'function') return null;
  const key = typeof hostElementOrId === 'object' ? autoRefreshUniq() : String(hostElementOrId);
  const previous = autoRefreshRuns.get(key);
  if (previous) autoRefreshUnregister(key);
  if (autoRefreshHostKeys && typeof hostElementOrId === 'object') { try { autoRefreshHostKeys.set(host, key); } catch {} }
  const named = previous && previous.key === key;
  const everyMs = Number.isFinite(Number(options.everyMs)) && Number(options.everyMs) > 0 ? Number(options.everyMs) : 30000;
  const entry = {
    key, host,
    load: options.load,
    everyMs,
    attempt: 0, inFlight: false, unregistered: false,
    lastUpdated: named ? previous.lastUpdated : 0,
    fingerprint: named ? previous.fingerprint : null,
    status: null, timer: null,
  };
  entry.handle = {
    key,
    get status(){ return entry.status; },
    refresh: () => void autoRefreshTick(entry, true),
    stop: () => autoRefreshUnregister(key),
  };
  autoRefreshRuns.set(key, entry);
  if (autoRefreshHostKeys && typeof hostElementOrId === 'object') { try { autoRefreshHostKeys.set(hostElementOrId, key); } catch {} }
  const line = autoRefreshLine();
  if (line) {
    const head = autoRefreshHead(host);
    if (head) head.appendChild(line);
    entry.status = line;
    if (entry.lastUpdated) line.textContent = autoRefreshStamp(entry.lastUpdated);
  }
  autoRefreshSchedule(entry);
  return entry.handle;
}
function autoRefreshUnregister(key){
  const entry = key == null || key === '' ? null : autoRefreshRuns.get(String(key));
  if (!entry) return false;
  entry.unregistered = true;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  autoRefreshRuns.delete(entry.key);
  try { entry.status?.remove?.(); } catch {}
  entry.status = null;
  return true;
}
function unregisterAutoRefresh(hostElementOrId){
  if (hostElementOrId && typeof hostElementOrId === 'object') {
    let key = null;
    try { key = autoRefreshHostKeys ? autoRefreshHostKeys.get(hostElementOrId) : null; } catch {}
    return autoRefreshUnregister(key);
  }
  return autoRefreshUnregister(hostElementOrId);
}
function autoRefreshTickSoon(){
  // Called by a screen right after its own save resolves, and by api() after any
  // successful save elsewhere: the in-flight count drops and the pending settle
  // releases a refresh so the new data shows as soon as it is safe.
  autoRefreshSettle();
}
function clearAutoRefreshSession(){
  for (const key of Array.from(autoRefreshRuns.keys())) autoRefreshUnregister(key);
}
