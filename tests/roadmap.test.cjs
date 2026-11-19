const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const member = {user: {id: 'member', email: 'member@example.test'}};

function setup(t, {
  session = null, denied = false, deferred = false, deferWrites = false,
  loginError = false, logoutError = false, settingsError = false, settingsConflict = false, loginDomain = '',
  activityLinks = [], linksAvailable = true, extraDevelopers = [], extraActivities = [],
  dsCapacityAvailable = true, dsBusinessSlots = 3, dsTechSlots = 1, goBusinessSlots = 4, goTechSlots = 2
} = {}) {
  const dom = new JSDOM(html, {url: 'https://roadmap.example.test/', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const $ = id => w.document.getElementById(id);
  const calls = [], pending = [], authCalls = [];
  let listener, clientOptions, realtimeListener, exportedBlob;
  const settings = {
    id: 'main', horizon_start: '2026-11-18', quarters: 2, business_slots: goBusinessSlots, tech_slots: goTechSlots, version: 1,
    developers: [{id: 'ds', name: 'Data scientist', role: 'DS'}, {id: 'go', name: 'Go developer', role: 'Go'}, ...extraDevelopers],
    ...(linksAvailable ? {activity_links: structuredClone(activityLinks)} : {}),
    ...(dsCapacityAvailable ? {ds_business_slots: dsBusinessSlots, ds_tech_slots: dsTechSlots} : {})
  };
  let activities = [
    {id: 'a1', resource: 'ds', name: 'DS activity', slot: 'One', type: 'Бизнес', qa: 'QA1'},
    {id: 'a2', resource: 'go', name: 'Go activity', slot: 'Two', type: 'Технический', qa: 'QA2'},
    {id: 'a3', resource: 'Legacy', name: 'Vacation', slot: '', type: 'Отпуск', qa: ''}, ...extraActivities
  ].map(a => ({...a, roadmap_id: 'main', start_date: '2026-11-18', end_date: '2026-11-30', version: 1}));
  const sb = {
    auth: {
      stopAutoRefresh() {}, startAutoRefresh() {},
      getSession: async () => ({data: {session}, error: null}),
      onAuthStateChange: fn => {listener = fn;},
      signInWithPassword: async credentials => {
        authCalls.push({email: credentials.email, passwordProvided: !!credentials.password});
        if (loginError) return {data: {session: null}, error: typeof loginError === 'object' ? loginError : {code: 'invalid_credentials', message: 'Invalid login'}};
        session = {user: {...member.user, email: credentials.email}};
        listener('SIGNED_IN', session);
        return {data: {session}, error: null};
      },
      signOut: async () => {
        if (logoutError) return {error: {message: 'Network unavailable'}};
        session = null; listener('SIGNED_OUT', null); return {error: null};
      }
    },
    from(table) {
      let operation = 'select', patch, filters = [];
      const query = {
        select() {return this;}, order() {return this;},
        eq(key, value) {filters.push([key, value]); return this;},
        update(value) {operation = 'update'; patch = value; return this;},
        insert(value) {operation = 'insert'; patch = value; return this;},
        delete() {operation = 'delete'; return this;},
        single() {return this;}, maybeSingle() {return this;},
        then(resolve, reject) {
          calls.push({table, operation, patch, filters});
          const execute = () => {
            if (denied) return {data: null, error: {code: 'PGRST116', message: 'No access'}};
            if (table === 'roadmap_settings') {
              if (operation === 'update') {
                if (settingsError) return {data: null, error: {message: 'Network unavailable'}};
                if (settingsConflict || !filters.every(([key, value]) => settings[key] === value)) return {data: null, error: null};
                Object.assign(settings, patch, {version: settings.version + 1});
              }
              return {data: structuredClone(settings), error: null};
            }
            if (operation === 'update') {
              const row = activities.find(a => filters.every(([key, value]) => a[key] === value));
              if (!row) return {data: null, error: null};
              Object.assign(row, patch, {version: row.version + 1});
              return {data: structuredClone(row), error: null};
            }
            if (operation === 'delete') {
              const removed = activities.filter(a => filters.every(([key, value]) => a[key] === value));
              activities = activities.filter(a => !removed.includes(a));
              return {data: structuredClone(filters.some(([key]) => key === 'id') ? removed[0] ?? null : removed), error: null};
            }
            if (operation === 'insert') {
              const inserted = (Array.isArray(patch) ? patch : [patch]).map(a => ({...a, id: a.id || w.crypto.randomUUID(), version: 1}));
              activities.push(...inserted);
              return {data: structuredClone(Array.isArray(patch) ? inserted : inserted[0]), error: null};
            }
            return {data: structuredClone(activities), error: null};
          };
          const response = execute();
          if (deferred || (deferWrites && operation !== 'select')) return new Promise(done => pending.push(() => done(response))).then(resolve, reject);
          return Promise.resolve(response).then(resolve, reject);
        }
      };
      return query;
    },
    channel() {return {on(event, filter, callback) {realtimeListener = callback; return this;}, subscribe() {return this;}};},
    removeChannel: async () => {}
  };
  w.ROADMAP_CONFIG = {supabaseUrl: 'https://backend.example.test', supabaseKey: 'test-only', roadmapId: 'main', loginDomain};
  w.supabase = {createClient(url, key, options) {clientOptions = options; return sb;}};
  w.alert = message => {throw new Error(message);};
  w.confirm = () => true;
  w.URL.createObjectURL = blob => {exportedBlob = blob; return 'blob:test-export';};
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  w.localStorage.setItem('roadmap-cloud-cache-v1', JSON.stringify({settings, activities}));
  w.eval(fs.readFileSync(path.join(root, 'static/js/link-routing.js'), 'utf8'));
  const ready = w.eval(script);
  return {w, $, calls, authCalls, pending, ready, settings, exported: () => exportedBlob, realtime: () => realtimeListener(), options: () => clientOptions,
    emit: next => {session = next; listener(next ? 'SIGNED_IN' : 'SIGNED_OUT', next);}};
}

test('anonymous visitor sees no roadmap, cached data, requests or export', async t => {
  const app = setup(t);
  await app.ready;
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.equal(app.$('accessGate').hidden, false);
  assert.equal(app.$('gantt').children.length, 0);
  assert.equal(app.w.localStorage.getItem('roadmap-cloud-cache-v1'), null);
  assert.equal(app.$('addActivity').disabled, true);
  assert.equal(app.calls.length, 0);
  app.$('exportJson').click();
  assert.equal(app.calls.length, 0);
  assert.equal(app.options().auth.storage, app.w.sessionStorage);
  assert.equal(app.options().auth.autoRefreshToken, true);
});

test('password sign-in opens roadmap; logout clears private DOM and editor fields', async t => {
  const app = setup(t);
  await app.ready;
  app.$('loginName').value = 'member@example.test';
  app.$('loginPassword').value = 'test-only-invalid-password';
  await app.$('loginForm').onsubmit({preventDefault() {}});
  await settle();
  assert.equal(app.$('roadmapApp').hidden, false);
  assert.match(app.$('gantt').textContent, /DS activity/);
  assert.equal(app.$('loginPassword').value, '');
  app.w.document.querySelector('[data-edit="a1"]').click();
  assert.equal(app.$('fName').value, 'DS activity');
  await app.$('signOut').onclick();
  await settle();
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.equal(app.$('gantt').textContent, '');
  assert.equal(app.$('dataTable').textContent, '');
  assert.equal(app.$('fName').value, '');
  assert.equal(app.$('developerList').textContent, '');
  assert.equal(app.$('editorModal').classList.contains('open'), false);
});

test('authenticated non-member stays behind the access gate', async t => {
  const app = setup(t, {session: member, denied: true});
  await app.ready;
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.equal(app.$('gantt').children.length, 0);
  assert.equal(app.$('addActivity').disabled, true);
  assert.equal(app.$('gateSignOut').hidden, false);
  assert.match(app.$('accessMessage').textContent, /недоступна/);
});

test('username sign-in maps to a technical account and displays only the login', async t => {
  const app = setup(t, {loginDomain: 'roadmap.invalid'});
  await app.ready;
  assert.equal(app.$('loginName').type, 'text');
  assert.equal(app.$('loginNameLabel').textContent, 'Логин');
  assert.equal(app.calls.length, 0);
  app.$('loginName').value = '  SGC  ';
  app.$('loginPassword').value = 'test-only-invalid-password';
  await app.$('loginForm').onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(app.authCalls, [{email: 'sgc@roadmap.invalid', passwordProvided: true}]);
  assert.equal(app.$('roadmapApp').hidden, false);
  assert.equal(app.$('loginPassword').value, '');
  assert.equal(app.$('currentUser').textContent, 'sgc');
  await app.$('signOut').onclick();
  await settle();
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.equal(app.$('gantt').textContent, '');
  assert.equal(app.w.document.activeElement.id, 'loginName');
});

test('invalid username cannot address another email domain or send a login request', async t => {
  const app = setup(t, {loginDomain: 'roadmap.invalid'});
  await app.ready;
  app.$('loginPassword').value = 'test-only-invalid-password';
  for (const login of ['user@another.invalid', '<script>', 'имя', '.user', 'a'.repeat(33)]) {
    app.$('loginName').value = login;
    await app.$('loginForm').onsubmit({preventDefault() {}});
    assert.equal(app.authCalls.length, 0, login);
  }
  assert.equal(app.calls.length, 0);
  assert.equal(app.$('roadmapApp').hidden, true);
});

test('wrong password for a username keeps data closed and reports the server error', async t => {
  const app = setup(t, {loginDomain: 'roadmap.invalid', loginError: true});
  await app.ready;
  app.$('loginName').value = 'sgc';
  app.$('loginPassword').value = 'test-only-invalid-password';
  await app.$('loginForm').onsubmit({preventDefault() {}});
  assert.equal(app.calls.length, 0);
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.match(app.$('accessMessage').textContent, /неверный логин или пароль/);
  assert.equal(app.$('loginPassword').value, '');
  assert.equal(app.$('accessErrorCode').textContent, 'Код: login/invalid_credentials');
});

test('username sign-in still requires membership in the roadmap', async t => {
  const app = setup(t, {loginDomain: 'roadmap.invalid', denied: true});
  await app.ready;
  app.$('loginName').value = 'sgc';
  app.$('loginPassword').value = 'test-only-invalid-password';
  await app.$('loginForm').onsubmit({preventDefault() {}});
  await settle();
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.equal(app.$('gantt').textContent, '');
  assert.match(app.$('accessMessage').textContent, /роадмапа недоступна/);
});

test('invalid password cannot trigger roadmap queries', async t => {
  const app = setup(t, {loginError: true});
  await app.ready;
  app.$('loginName').value = 'member@example.test';
  app.$('loginPassword').value = 'test-only-invalid-password';
  await app.$('loginForm').onsubmit({preventDefault() {}});
  assert.equal(app.calls.length, 0);
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.equal(app.$('loginPassword').value, '');
  assert.equal(app.$('loginSubmit').disabled, false);
  assert.match(app.$('accessMessage').textContent, /Не удалось войти/);
});

test('failed network logout cannot reopen a session through a delayed auth event', async t => {
  const app = setup(t, {session: member, logoutError: true});
  await app.ready;
  app.w.sessionStorage.setItem('roadmap-auth-main', 'test-only-session');
  await app.$('signOut').onclick();
  app.emit(member);
  await settle();
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.equal(app.$('gantt').textContent, '');
  assert.equal(app.w.sessionStorage.getItem('roadmap-auth-main'), null);
  assert.equal(app.$('loginSubmit').disabled, true);
});

test('unconfirmed email gets an actionable message without exposing raw server details', async t => {
  const app = setup(t, {loginError: {code: 'email_not_confirmed', message: 'private server detail'}});
  await app.ready;
  app.$('loginName').value = 'member@example.test';
  app.$('loginPassword').value = 'test-only-invalid-password';
  await app.$('loginForm').onsubmit({preventDefault() {}});
  assert.match(app.$('accessMessage').textContent, /Email не подтверждён/);
  assert.equal(app.$('accessErrorCode').textContent, 'Код: login/email_not_confirmed');
  assert.doesNotMatch(app.w.document.body.textContent, /private server detail/);
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.equal(app.calls.length, 0);
});

test('missing roadmap access is distinguished from a password error', async t => {
  const app = setup(t, {session: member, denied: true});
  await app.ready;
  assert.match(app.$('accessMessage').textContent, /Вход выполнен/);
  assert.match(app.$('accessMessage').textContent, /проверить доступ пользователя/);
  assert.equal(app.$('accessErrorCode').textContent, 'Код: roadmap/PGRST116');
  assert.equal(app.$('gateSignOut').hidden, false);
});

test('late data response after logout cannot restore the private view', async t => {
  const app = setup(t, {session: member, deferred: true});
  await settle();
  assert.equal(app.pending.length, 2);
  await app.$('signOut').onclick();
  app.pending.forEach(resolve => resolve());
  await app.ready;
  await settle();
  assert.equal(app.$('roadmapApp').hidden, true);
  assert.equal(app.$('gantt').children.length, 0);
});

test('team filter affects Gantt, table, capacity and QA without writes', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  assert.equal(app.w.document.querySelectorAll('.resource-row').length, 3);
  app.$('teamFilter').value = 'DS';
  app.$('teamFilter').dispatchEvent(new app.w.Event('change'));
  assert.equal(app.w.document.querySelectorAll('.resource-row').length, 1);
  assert.match(app.$('gantt').textContent, /DS activity/);
  assert.doesNotMatch(app.$('gantt').textContent, /Go activity/);
  assert.equal(app.w.document.querySelectorAll('#dataTable tbody tr').length, 1);
  assert.match(app.$('capacity').textContent, /QA1/);
  assert.doesNotMatch(app.$('capacity').textContent, /QA2/);
  const rows = app.w.document.querySelectorAll('#capacity .cap-row');
  assert.equal(rows[1].querySelector('.cap-cell').textContent, '1 / 3');
  assert.equal(rows[2].querySelector('.cap-cell').textContent, '0 / 1');
  app.$('teamFilter').value = 'Go';
  app.$('teamFilter').dispatchEvent(new app.w.Event('change'));
  assert.match(app.$('gantt').textContent, /Go activity/);
  app.$('teamFilter').value = 'unassigned';
  app.$('teamFilter').dispatchEvent(new app.w.Event('change'));
  assert.match(app.$('gantt').textContent, /Legacy/);
  app.$('teamFilter').value = 'all';
  app.$('teamFilter').dispatchEvent(new app.w.Event('change'));
  assert.equal(app.w.document.querySelectorAll('.resource-row').length, 3);
  assert.ok(app.calls.every(c => c.operation === 'select'));
});

test('calendar rows own their positioning; resize handle has no label styles; titles follow dates', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  for (const cls of ['quarter-row', 'month-row', 'week-row']) {
    assert.equal(app.w.getComputedStyle(app.w.document.querySelector('.' + cls)).position, 'relative');
  }
  const handle = app.w.document.querySelector('.handle.resize-left');
  assert.equal(app.w.getComputedStyle(handle).width, '7px');
  assert.equal(app.w.getComputedStyle(handle).backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(handle.classList.contains('resource-label'), false);
  assert.match(app.$('roadmapPeriod').textContent, /18.11.2026 — 31.03.2027/);
  assert.match(app.w.document.querySelector('.weekseg').textContent, /ср–вт/);
});

test('shared visibility survives reload and restores activities without deleting them', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.$('manageDevelopers').click();
  const checkbox = app.w.document.querySelector('[data-visible="ds"]');
  checkbox.checked = false;
  await checkbox.onchange();
  assert.doesNotMatch(app.$('gantt').textContent, /DS activity/);
  assert.doesNotMatch(app.$('dataTable').textContent, /DS activity/);
  assert.doesNotMatch(app.$('capacity').textContent, /QA1/);
  assert.equal(app.w.document.querySelector('[data-visible="ds"]').checked, false);
  const saved = app.calls.find(c => c.operation === 'update');
  assert.equal(saved.table, 'roadmap_settings');
  assert.deepEqual(saved.filters, [['id', 'main'], ['version', 1]]);
  assert.equal(saved.patch.developers.find(d => d.id === 'ds').hidden, true);
  await app.$('reloadCloud').onclick();
  assert.doesNotMatch(app.$('gantt').textContent, /DS activity/);
  assert.match(app.$('developerList').textContent, /Data scientist/);
  await app.$('showAllDevelopers').onclick();
  assert.match(app.$('gantt').textContent, /DS activity/);
  assert.equal(app.w.document.querySelectorAll('#dataTable tbody tr').length, 3);
  assert.ok(app.calls.filter(c => c.operation !== 'select').every(c => c.table === 'roadmap_settings'));
});

test('arrows and drag-and-drop save shared ordering for the diagram and table', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  const order = () => [...app.w.document.querySelectorAll('#gantt .developer-name')].map(el => el.textContent);
  await app.w.document.querySelector('[data-move="go"][data-direction="-1"]').onclick();
  assert.deepEqual(order(), ['Go developer', 'Data scientist', 'Legacy']);
  await app.$('reloadCloud').onclick();
  assert.deepEqual(order(), ['Go developer', 'Data scientist', 'Legacy']);
  assert.match(app.w.document.querySelector('#dataTable tbody tr').textContent, /Go activity/);
  const dataTransfer = {setData() {}};
  app.w.document.querySelector('[data-grip="Legacy"]').ondragstart({dataTransfer});
  await app.w.document.querySelector('[data-row="go"]').ondrop({preventDefault() {}});
  assert.deepEqual(order(), ['Legacy', 'Go developer', 'Data scientist']);
  assert.equal(app.w.document.querySelector('[data-move="Legacy"][data-direction="-1"]').disabled, true);
  assert.equal(app.w.document.querySelector('[data-move="ds"][data-direction="1"]').disabled, true);
});

test('developer editing preserves hidden state and position, including view changes during editing', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  await app.w.document.querySelector('[data-move="ds"][data-direction="1"]').onclick();
  app.w.document.querySelector('[data-developer="ds"]').click();
  app.$('developerName').value = 'Renamed scientist';
  const checkbox = app.w.document.querySelector('[data-visible="ds"]');
  checkbox.checked = false;
  await checkbox.onchange();
  assert.equal(app.$('developerName').value, 'Renamed scientist');
  await app.$('developerForm').onsubmit({preventDefault() {}});
  const saved = app.calls.filter(c => c.operation === 'update').at(-1);
  const renamed = saved.patch.developers.find(d => d.id === 'ds');
  assert.equal(renamed.name, 'Renamed scientist');
  assert.equal(renamed.hidden, true);
  assert.equal(renamed.order, 1);
  assert.deepEqual(saved.filters, [['id', 'main'], ['version', 3]]);
  assert.doesNotMatch(app.$('gantt').textContent, /DS activity/);
  assert.match(app.$('developerList').textContent, /Renamed scientist/);
});

test('failed shared visibility save restores the checkbox and leaves the roadmap unchanged', async t => {
  const app = setup(t, {session: member, settingsError: true});
  await app.ready;
  const checkbox = app.w.document.querySelector('[data-visible="ds"]');
  checkbox.checked = false;
  await checkbox.onchange();
  assert.equal(app.w.document.querySelector('[data-visible="ds"]').checked, true);
  assert.equal(app.w.document.querySelector('[data-visible="ds"]').disabled, false);
  assert.match(app.$('gantt').textContent, /DS activity/);
  assert.match(app.$('developerError').textContent, /Ошибка сохранения вида/);
});

test('conflicting shared view updates reload cloud state instead of overwriting it', async t => {
  const app = setup(t, {session: member, settingsConflict: true});
  await app.ready;
  await app.w.document.querySelector('[data-move="go"][data-direction="-1"]').onclick();
  const order = [...app.w.document.querySelectorAll('#gantt .developer-name')].map(el => el.textContent);
  assert.deepEqual(order, ['Data scientist', 'Go developer', 'Legacy']);
  assert.match(app.$('developerError').textContent, /уже изменён другим участником/);
  assert.equal(app.calls.filter(c => c.table === 'roadmap_settings' && c.operation === 'select').length, 2);
});

test('activity edits retain optimistic version checking and authenticated saves', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.w.document.querySelector('[data-edit="a1"]').click();
  app.$('fName').value = 'Updated activity';
  await app.$('saveActivity').onclick();
  const update = app.calls.find(c => c.operation === 'update');
  assert.deepEqual(update.filters, [['id', 'a1'], ['version', 1]]);
  assert.equal(update.patch.name, 'Updated activity');
  assert.match(app.$('dataTable').textContent, /Updated activity/);
});

const rowControl = (app, id, action) => app.w.document.querySelector(`[data-resource="${id}"] [data-inline="${action}"]`);
const bar = (app, id) => app.w.document.querySelector(`.bar[data-id="${id}"]`);
const links = app => [...app.w.document.querySelectorAll('.activity-link')];
async function connect(app, from, to) {
  app.$('addLink').click();
  bar(app, from).click();
  bar(app, to).click();
  await settle();
}
async function exportedData(app) {
  app.$('exportJson').click();
  const text = await new Promise((resolve, reject) => {
    const reader = new app.w.FileReader();
    reader.onload = () => resolve(reader.result); reader.onerror = reject;
    reader.readAsText(app.exported());
  });
  return JSON.parse(text);
}

test('direct row controls hide and restore a developer for the team without opening a modal', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  rowControl(app, 'ds', 'hide').focus();
  await rowControl(app, 'ds', 'hide').onclick();
  assert.equal(bar(app, 'a1'), null);
  assert.equal(app.$('developersModal').classList.contains('open'), false);
  assert.equal(app.$('restoreDevelopers').hidden, false);
  assert.equal(app.w.document.activeElement.id, 'restoreDevelopers');
  assert.match(app.$('ganttStatus').textContent, /скрыт для всей команды/);
  await app.$('reloadCloud').onclick();
  assert.equal(bar(app, 'a1'), null);
  await app.$('restoreDevelopers').onclick();
  assert.ok(bar(app, 'a1'));
  assert.equal(app.$('restoreDevelopers').hidden, true);
  assert.equal(app.calls.filter(c => c.operation === 'delete').length, 0);
});

test('direct row movement skips hidden and filtered developers and supports dragging', async t => {
  const app = setup(t, {session: member, extraDevelopers: [
    {id: 'hidden', name: 'Earlier hidden', role: 'DS', hidden: true},
    {id: 'ds2', name: 'Second scientist', role: 'DS'}
  ]});
  await app.ready;
  app.$('teamFilter').value = 'DS'; app.$('teamFilter').onchange();
  assert.equal(rowControl(app, 'ds', 'up').disabled, true);
  rowControl(app, 'ds', 'down').focus();
  await rowControl(app, 'ds', 'down').onclick();
  const ids = () => [...app.w.document.querySelectorAll('#gantt .resource-row')].map(r => r.dataset.resource);
  assert.deepEqual(ids(), ['ds2', 'ds']);
  assert.equal(rowControl(app, 'ds', 'down').disabled, true);
  assert.equal(app.w.document.activeElement.closest('.resource-row').dataset.resource, 'ds');
  app.$('teamFilter').value = 'all'; app.$('teamFilter').onchange();
  const dataTransfer = {setData() {}};
  rowControl(app, 'ds', 'grip').ondragstart({dataTransfer});
  await rowControl(app, 'go', 'grip').closest('.resource-row').ondrop({preventDefault() {}});
  assert.deepEqual(ids(), ['ds', 'go', 'Legacy', 'ds2']);
  await app.$('reloadCloud').onclick();
  assert.deepEqual(ids(), ['ds', 'go', 'Legacy', 'ds2']);
});

test('direct row save errors are visible on the roadmap and preserve the original rows', async t => {
  const app = setup(t, {session: member, settingsError: true});
  await app.ready;
  await rowControl(app, 'ds', 'hide').onclick();
  assert.ok(bar(app, 'a1'));
  assert.equal(app.$('ganttStatus').hidden, false);
  assert.match(app.$('ganttStatus').textContent, /Ошибка сохранения вида/);
  assert.equal(rowControl(app, 'ds', 'hide').disabled, false);
});

test('DS → Go and Go → DS links persist independently and can be deleted without changing projects', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  assert.equal(app.$('linkContext').hidden, true);
  await connect(app, 'a1', 'a2');
  assert.equal(links(app).length, 1);
  const first = app.calls.find(c => c.operation === 'update');
  assert.deepEqual(first.filters, [['id', 'main'], ['version', 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(first.patch)), {activity_links: [{from: 'a1', to: 'a2'}]});
  await connect(app, 'a2', 'a1');
  assert.equal(links(app).length, 2);
  assert.notEqual(links(app)[0].getAttribute('d'), links(app)[1].getAttribute('d'));
  await app.$('reloadCloud').onclick();
  assert.equal(links(app).length, 2);
  const hit = app.w.document.querySelector('.link-hit');
  hit.dispatchEvent(new app.w.KeyboardEvent('keydown', {key: 'Enter'}));
  assert.equal(app.$('deleteLink').hidden, false);
  assert.equal(app.$('linkContext').hidden, false);
  assert.match(app.$('linkHint').textContent, /DS activity → Go activity/);
  await app.$('deleteLink').onclick();
  assert.equal(app.$('linkContext').hidden, true);
  assert.equal(links(app).length, 1);
  assert.equal(links(app)[0].dataset.from, 'a2');
  assert.equal(app.calls.filter(c => c.operation !== 'select' && c.table !== 'roadmap_settings').length, 0);
});

test('link creation rejects self, vacation and duplicate links, supports keyboard and Escape', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.$('addLink').click();
  bar(app, 'a3').click();
  assert.match(app.$('ganttStatus').textContent, /отпуск/);
  bar(app, 'a1').dispatchEvent(new app.w.KeyboardEvent('keydown', {key: 'Enter'}));
  bar(app, 'a1').click();
  assert.match(app.$('ganttStatus').textContent, /другой проект/);
  app.$('gantt').dispatchEvent(new app.w.MouseEvent('pointermove', {clientX: 300, clientY: 170}));
  assert.match(app.w.document.querySelector('.link-preview').getAttribute('d'), /^M /);
  assert.equal(app.calls.filter(c => c.operation === 'update').length, 0);
  bar(app, 'a2').dispatchEvent(new app.w.KeyboardEvent('keydown', {key: ' '}));
  await settle();
  await connect(app, 'a1', 'a2');
  assert.match(app.$('ganttStatus').textContent, /уже есть/);
  assert.equal(app.calls.filter(c => c.operation === 'update').length, 1);
  app.w.document.dispatchEvent(new app.w.KeyboardEvent('keydown', {key: 'Escape'}));
  assert.equal(app.$('gantt').classList.contains('linking'), false);
  assert.equal(app.w.document.querySelector('.link-preview'), null);
  assert.equal(app.$('editorModal').classList.contains('open'), false);
});

test('opposite arrows between non-overlapping projects have separate paths for selection', async t => {
  const app = setup(t, {session: member, activityLinks: [{from: 'a1', to: 'a2'}, {from: 'a2', to: 'a1'}]});
  await app.ready;
  app.w.document.querySelector('[data-edit="a2"]').click();
  app.$('fStart').value = '2026-12-15'; app.$('fEnd').value = '2026-12-25';
  await app.$('saveActivity').onclick();
  const points = links(app).map(line => line.getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number));
  assert.notDeepEqual(points[0].slice(0, 2), points[1].slice(-2));
  assert.notDeepEqual(points[1].slice(0, 2), points[0].slice(-2));
  assert.ok(points.flat().every(Number.isFinite));
});

test('links follow dates, resizing and row order; hiding and filtering endpoints do not delete links', async t => {
  const app = setup(t, {session: member, activityLinks: [{from: 'a1', to: 'a2'}]});
  await app.ready;
  const before = links(app)[0].getAttribute('d');
  bar(app, 'a1').querySelector('.drag-area').dispatchEvent(new app.w.MouseEvent('pointerdown', {bubbles: true, clientX: 200, button: 0}));
  app.w.document.dispatchEvent(new app.w.MouseEvent('pointermove', {clientX: 228}));
  const moving = links(app)[0].getAttribute('d');
  assert.notEqual(moving, before);
  app.w.document.dispatchEvent(new app.w.MouseEvent('pointerup'));
  await settle();
  assert.equal(links(app)[0].getAttribute('d'), moving);
  assert.equal(app.calls.find(c => c.operation === 'update').patch.start_date, '2026-11-20');
  bar(app, 'a1').querySelector('.resize-right').dispatchEvent(new app.w.MouseEvent('pointerdown', {bubbles: true, clientX: 200, button: 0}));
  app.w.document.dispatchEvent(new app.w.MouseEvent('pointermove', {clientX: 270}));
  const resized = links(app)[0].getAttribute('d');
  assert.notEqual(resized, moving);
  app.w.document.dispatchEvent(new app.w.MouseEvent('pointerup'));
  await settle();
  assert.equal(links(app)[0].getAttribute('d'), resized);
  await rowControl(app, 'ds', 'down').onclick();
  const reordered = links(app)[0].getAttribute('d');
  assert.notEqual(reordered, resized);
  await rowControl(app, 'ds', 'hide').onclick();
  assert.equal(links(app).length, 0);
  assert.equal((await exportedData(app)).settings.activityLinks.length, 1);
  await app.$('restoreDevelopers').onclick();
  assert.equal(links(app)[0].getAttribute('d'), reordered);
  app.$('teamFilter').value = 'Go'; app.$('teamFilter').onchange();
  assert.equal(links(app).length, 0);
  app.$('teamFilter').value = 'all'; app.$('teamFilter').onchange();
  assert.equal(links(app).length, 1);
});

for (const failure of ['settingsError', 'settingsConflict']) {
  test(`failed link save (${failure}) does not add a local arrow or overwrite remote state`, async t => {
    const app = setup(t, {session: member, [failure]: true});
    await app.ready;
    await connect(app, 'a1', 'a2');
    assert.equal(links(app).length, 0);
    assert.equal(app.$('ganttStatus').classList.contains('error'), true);
    assert.match(app.$('ganttStatus').textContent, failure === 'settingsConflict' ? /актуальная версия/ : /Не удалось сохранить/);
    assert.equal(app.$('addLink').disabled, false);
    if (failure === 'settingsConflict') assert.equal(app.calls.filter(c => c.table === 'roadmap_settings' && c.operation === 'select').length, 2);
  });
}

test('realtime updates reload arrows, while old schema leaves ordinary roadmap editing available', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.settings.activity_links = [{from: 'a2', to: 'a1'}];
  app.realtime();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(links(app)[0].dataset.from, 'a2');
  const old = setup(t, {session: member, linksAvailable: false});
  await old.ready;
  assert.equal(old.$('addLink').disabled, true);
  assert.match(old.$('linkHint').textContent, /пока не подключены/);
  await rowControl(old, 'ds', 'hide').onclick();
  assert.equal(bar(old, 'a1'), null);
  assert.ok(!('activity_links' in old.calls.find(c => c.operation === 'update').patch));
});

test('pending link save prevents duplicate writes and cannot restore data after logout', async t => {
  const app = setup(t, {session: member, deferWrites: true});
  await app.ready;
  await connect(app, 'a1', 'a2');
  assert.equal(app.pending.length, 1);
  assert.equal(app.$('addLink').disabled, true);
  assert.equal(rowControl(app, 'ds', 'hide').disabled, true);
  bar(app, 'a2').click();
  await rowControl(app, 'ds', 'hide').onclick();
  assert.equal(app.pending.length, 1);
  await app.$('signOut').onclick();
  app.pending.shift()();
  await settle();
  assert.equal(app.$('gantt').textContent, '');
  assert.equal(app.$('linkHint').textContent, '');
  assert.equal(app.$('ganttStatusText').textContent, '');
  assert.equal(app.$('ganttStatus').hidden, true);
  assert.equal(app.$('roadmapApp').hidden, true);
});

test('deleting an activity removes its connections from rendering and export, including after reload', async t => {
  const app = setup(t, {session: member, activityLinks: [{from: 'a1', to: 'a2'}, {from: 'missing', to: 'a2'}]});
  await app.ready;
  assert.equal(links(app).length, 1);
  app.w.document.querySelector('[data-edit="a1"]').click();
  await app.$('deleteActivity').onclick();
  await app.$('reloadCloud').onclick();
  assert.equal(links(app).length, 0);
  const exported = await exportedData(app);
  assert.deepEqual(exported.settings.activityLinks, []);
  assert.equal(exported.activities.length, 2);
});

test('export and import retain shared visibility and remap directed links to fresh activity IDs', async t => {
  const app = setup(t, {session: member, activityLinks: [{from: 'a1', to: 'a2'}, {from: 'a2', to: 'a1'}]});
  await app.ready;
  await rowControl(app, 'ds', 'hide').onclick();
  const exported = await exportedData(app);
  assert.equal(exported.activities.length, 3);
  assert.equal(exported.settings.activityLinks.length, 2);
  Object.defineProperty(app.$('jsonFile'), 'files', {value: [{text: async () => JSON.stringify(exported)}]});
  await app.$('jsonFile').onchange();
  const imported = await exportedData(app);
  const dsId = imported.activities.find(a => a.resource === 'ds').id;
  const goId = imported.activities.find(a => a.resource === 'go').id;
  assert.notEqual(dsId, 'a1'); assert.notEqual(goId, 'a2');
  assert.deepEqual(imported.settings.activityLinks, [{from: dsId, to: goId}, {from: goId, to: dsId}]);
  assert.equal(links(app).length, 0);
  await app.$('restoreDevelopers').onclick();
  assert.equal(links(app).length, 2);
});

test('import refuses broken links before deleting any cloud data', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  const imported = await exportedData(app);
  imported.settings.activityLinks = [{from: 'a1', to: 'missing'}];
  Object.defineProperty(app.$('jsonFile'), 'files', {value: [{text: async () => JSON.stringify(imported)}]});
  const errors = [];
  app.w.alert = message => errors.push(message);
  app.w.console.error = () => {};
  await app.$('jsonFile').onchange();
  assert.match(errors[0], /отсутствующий проект/);
  assert.equal(app.calls.filter(c => c.operation !== 'select').length, 0);
  assert.equal(app.w.document.querySelectorAll('.bar').length, 3);
});

test('searchable people picker toggles shared visibility and chips restore individuals', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.$('peopleMenu').open = true;
  app.$('peopleSearch').value = 'SCIENTIST'; app.$('peopleSearch').oninput();
  assert.equal(app.w.document.querySelectorAll('[data-person]').length, 1);
  const toggle = app.w.document.querySelector('[data-person="ds"]');
  toggle.checked = false; await toggle.onchange();
  assert.equal(app.$('peopleMenu').open, true);
  assert.equal(app.w.document.activeElement.dataset.person, 'ds');
  assert.equal(bar(app, 'a1'), null);
  assert.match(app.$('peopleCount').textContent, /2 \/ 3/);
  assert.match(app.$('hiddenPeople').textContent, /Data scientist/);
  assert.equal(app.$('developersModal').classList.contains('open'), false);
  await app.w.document.querySelector('[data-restore="ds"]').onclick();
  assert.ok(bar(app, 'a1'));
  assert.equal(app.$('hiddenPeople').hidden, true);
  app.w.document.dispatchEvent(new app.w.KeyboardEvent('keydown', {key: 'Escape'}));
  assert.equal(app.$('peopleMenu').open, false);
});

test('failed visibility toggle restores its value and reports the error outside the editor', async t => {
  const app = setup(t, {session: member, settingsError: true});
  await app.ready;
  const toggle = app.w.document.querySelector('[data-person="ds"]');
  toggle.checked = false; await toggle.onchange();
  assert.equal(app.w.document.querySelector('[data-person="ds"]').checked, true);
  assert.equal(app.$('hiddenPeople').hidden, true);
  assert.equal(app.$('ganttStatus').classList.contains('error'), true);
});

function pointer(app, node, type, x, y) {
  node.dispatchEvent(new app.w.MouseEvent(type, {bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y}));
}

test('dragging the connection handle highlights the target, previews an arrow and persists on release', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  const port = app.w.document.querySelector('[data-link-from="a1"]');
  pointer(app, port, 'pointerdown', 200, 100);
  pointer(app, bar(app, 'a2'), 'pointermove', 220, 200);
  assert.equal(bar(app, 'a1').classList.contains('link-source'), true);
  assert.equal(bar(app, 'a2').classList.contains('link-target'), true);
  assert.equal(app.$('linkDragTip').hidden, false);
  assert.match(app.w.document.querySelector('.link-preview').getAttribute('d'), /^M /);
  pointer(app, bar(app, 'a2'), 'pointerup', 220, 200);
  await settle();
  assert.equal(links(app).length, 1);
  assert.equal(links(app)[0].dataset.from, 'a1');
  assert.equal(app.$('linkDragTip').hidden, true);
  assert.equal(app.$('editorModal').classList.contains('open'), false);
  assert.equal(app.calls.filter(c => c.operation === 'update').length, 1);
  assert.equal(app.calls.filter(c => c.table === 'roadmap_activities' && c.operation !== 'select').length, 0);
});

test('connection gestures cancel on Escape, pointer cancellation or release outside a project', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  for (const ending of ['escape', 'pointercancel', 'pointerup']) {
    pointer(app, app.w.document.querySelector('[data-link-from="a1"]'), 'pointerdown', 200, 100);
    pointer(app, app.$('gantt'), 'pointermove', 500, 500);
    if (ending === 'escape') app.w.document.dispatchEvent(new app.w.KeyboardEvent('keydown', {key: 'Escape'}));
    else pointer(app, app.$('gantt'), ending, 500, 500);
    assert.equal(app.$('gantt').classList.contains('linking'), false);
    assert.equal(app.$('linkDragTip').hidden, true);
    assert.equal(app.w.document.querySelector('.link-preview'), null);
  }
  assert.equal(app.calls.filter(c => c.operation !== 'select').length, 0);
});

test('clicking a connection handle also supports two-click linking and reversing without duplicates', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.w.document.querySelector('[data-link-from="a2"]').click();
  bar(app, 'a1').click(); await settle();
  assert.equal(links(app)[0].dataset.from, 'a2');
  app.w.document.querySelector('.link-hit').dispatchEvent(new app.w.MouseEvent('click', {bubbles: true}));
  assert.equal(app.$('reverseLink').hidden, false);
  await app.$('reverseLink').onclick();
  assert.equal(links(app)[0].dataset.from, 'a1');
  assert.equal(links(app).length, 1);
  assert.ok(links(app)[0].closest('.link-group').querySelector('.link-halo'));
  assert.match(links(app)[0].getAttribute('marker-end'), /ds/);
});

test('logout during a gesture clears developer names and cannot create a delayed link', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.$('peopleSearch').value = 'Data scientist';
  app.$('capacitySection').open = true; app.$('dataSection').open = true; app.$('settingsSection').open = true;
  pointer(app, app.w.document.querySelector('[data-link-from="a1"]'), 'pointerdown', 200, 100);
  pointer(app, bar(app, 'a2'), 'pointermove', 220, 200);
  await app.$('signOut').onclick();
  pointer(app, app.w.document, 'pointerup', 220, 200);
  await settle();
  assert.equal(app.$('peopleOptions').textContent, '');
  assert.equal(app.$('peopleSearch').value, '');
  assert.equal(app.$('hiddenPeople').textContent, '');
  assert.equal(app.$('linkDragTip').textContent, '');
  assert.equal(app.$('gantt').textContent, '');
  assert.equal(app.$('roadmapPeriod').textContent, '');
  for (const id of ['capacitySection', 'dataSection', 'settingsSection']) assert.equal(app.$(id).open, false);
  assert.equal(app.calls.filter(c => c.operation !== 'select').length, 0);
});

test('collapsed secondary sections keep their content and an open project list survives edits', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  for (const id of ['capacitySection', 'dataSection', 'settingsSection']) {
    assert.equal(app.$(id).open, false);
    app.$(id).querySelector('summary').click();
    assert.equal(app.$(id).open, true);
  }
  assert.equal(app.calls.filter(c => c.operation !== 'select').length, 0);
  assert.match(app.$('capacity').textContent, /QA1/);
  app.w.document.querySelector('[data-edit="a1"]').click();
  app.$('fName').value = 'Edited from expanded list';
  await app.$('saveActivity').onclick();
  assert.equal(app.$('dataSection').open, true);
  assert.match(app.$('dataTable').textContent, /Edited from expanded list/);
  assert.match(app.$('gantt').textContent, /Edited from expanded list/);
});

test('More menu exposes vacation creation, closes after choosing it and focuses the editor', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.$('moreMenu').querySelector('summary').click();
  await settle();
  assert.equal(app.$('moreMenu').open, true);
  app.$('addVacation').click();
  assert.equal(app.$('moreMenu').open, false);
  assert.equal(app.$('editorModal').classList.contains('open'), true);
  assert.equal(app.$('fType').value, 'Отпуск');
  assert.equal(app.w.document.activeElement.id, 'fName');
  assert.equal(app.calls.filter(c => c.operation !== 'select').length, 0);
});

test('disclosures close on outside click or Escape without hiding a focused control', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.$('peopleMenu').querySelector('summary').click(); await settle();
  assert.equal(app.w.document.activeElement.id, 'peopleSearch');
  app.$('moreMenu').querySelector('summary').click(); await settle();
  assert.equal(app.$('peopleMenu').open, false);
  assert.equal(app.$('moreMenu').open, true);
  app.w.document.dispatchEvent(new app.w.KeyboardEvent('keydown', {key: 'Escape'}));
  assert.equal(app.$('moreMenu').open, false);
  assert.equal(app.w.document.activeElement, app.$('moreMenu').querySelector('summary'));
  app.$('roadmapHelp').querySelector('summary').click(); await settle();
  app.$('roadmapTitle').click();
  assert.equal(app.$('roadmapHelp').open, false);
});

test('status notifications can be dismissed without undoing saved changes', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  await rowControl(app, 'ds', 'hide').onclick();
  assert.equal(app.$('ganttStatus').hidden, false);
  app.$('dismissGanttStatus').click();
  assert.equal(app.$('ganttStatus').hidden, true);
  assert.equal(app.$('ganttStatusText').textContent, '');
  assert.equal(bar(app, 'a1'), null);
  assert.equal(app.settings.developers.find(d => d.id === 'ds').hidden, true);
});

test('many hidden developers keep a compact row with access to the complete picker', async t => {
  const app = setup(t, {session: member, extraDevelopers: Array.from({length: 6}, (_,i) => ({id: `hidden-${i}`, name: `Hidden ${i}`, role: 'DS', hidden: true}))});
  await app.ready;
  assert.equal(app.w.document.querySelectorAll('[data-restore]').length, 3);
  app.w.document.querySelector('[data-more-hidden]').click(); await settle();
  assert.equal(app.$('peopleMenu').open, true);
  assert.equal(app.w.document.querySelectorAll('[data-person]:not(:checked)').length, 6);
  const toggle = app.w.document.querySelector('[data-person="hidden-5"]');
  toggle.checked = true; await toggle.onchange();
  assert.ok(rowControl(app, 'hidden-5', 'hide'));
});

test('connection dragging cannot select a project underneath the sticky calendar', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.$('gantt').parentElement.getBoundingClientRect = () => ({width: 800, left: 0, right: 800, top: 50, bottom: 500});
  pointer(app, app.w.document.querySelector('[data-link-from="a1"]'), 'pointerdown', 220, 200);
  pointer(app, bar(app, 'a2'), 'pointermove', 240, 100);
  pointer(app, bar(app, 'a2'), 'pointerup', 240, 100);
  await settle();
  assert.equal(links(app).length, 0);
  assert.equal(app.$('linkContext').hidden, true);
  assert.equal(app.calls.filter(c => c.operation !== 'select').length, 0);
});

const capacityCell = (app, label, week = 0) => [...app.$('capacity').querySelectorAll('.cap-row')]
  .find(row => row.querySelector('.cap-label').textContent === label)?.querySelectorAll('.cap-cell')[week];

test('DS business and technical overloads are checked against 3/1 independently of Go', async t => {
  const app = setup(t, {session: member, extraActivities: [
    ...[2, 3, 4].map(i => ({id: `ds-business-${i}`, name: `DS business ${i}`, resource: 'ds', slot: `DS business ${i}`, type: 'Бизнес'})),
    ...[1, 2].map(i => ({id: `ds-tech-${i}`, name: `DS tech ${i}`, resource: 'ds', slot: `DS tech ${i}`, type: 'Технический'}))
  ]});
  await app.ready;
  assert.equal(capacityCell(app, 'DS · Бизнес').textContent, '4 / 3');
  assert.equal(capacityCell(app, 'DS · Технические').textContent, '2 / 1');
  assert.equal(capacityCell(app, 'DS · Бизнес').classList.contains('warn'), true);
  assert.equal(capacityCell(app, 'DS · Технические').classList.contains('warn'), true);
  assert.equal(capacityCell(app, 'Go · Бизнес').textContent, '0 / 4');
  assert.equal(capacityCell(app, 'Go · Технические').textContent, '1 / 2');
  assert.equal(capacityCell(app, 'Go · Технические').classList.contains('ok'), true);
  app.$('teamFilter').value = 'Go'; app.$('teamFilter').onchange();
  assert.equal(capacityCell(app, 'DS · Бизнес'), undefined);
  assert.equal(capacityCell(app, 'Go · Технические').textContent, '1 / 2');
  assert.equal(app.calls.filter(c => c.operation !== 'select').length, 0);
});

test('a shared project slot counts once within each team, and unassigned projects have no team limit', async t => {
  const app = setup(t, {session: member,
    extraDevelopers: [{id: 'ds2', name: 'Second scientist', role: 'DS'}],
    extraActivities: [
      {id: 'ds-collab', resource: 'ds2', name: 'Shared project', slot: 'One', type: 'Бизнес'},
      {id: 'go-collab', resource: 'go', name: 'Shared project', slot: 'One', type: 'Бизнес'},
      {id: 'unknown', resource: 'Not assigned', name: 'Shared project', slot: 'One', type: 'Бизнес'}
    ]
  });
  await app.ready;
  assert.equal(capacityCell(app, 'DS · Бизнес').textContent, '1 / 3');
  assert.equal(capacityCell(app, 'Go · Бизнес').textContent, '1 / 4');
  assert.equal(capacityCell(app, 'Без команды · Бизнес').textContent, '1');
  assert.equal(capacityCell(app, 'Без команды · Бизнес').classList.contains('neutral'), true);
  await rowControl(app, 'ds', 'hide').onclick();
  assert.equal(capacityCell(app, 'DS · Бизнес').textContent, '1 / 3');
  await rowControl(app, 'ds2', 'hide').onclick();
  assert.equal(capacityCell(app, 'DS · Бизнес').textContent, '0 / 3');
  assert.equal(capacityCell(app, 'Go · Бизнес').textContent, '1 / 4');
  app.$('teamFilter').value = 'unassigned'; app.$('teamFilter').onchange();
  assert.equal(capacityCell(app, 'DS · Бизнес'), undefined);
  assert.equal(capacityCell(app, 'Go · Бизнес'), undefined);
  assert.equal(capacityCell(app, 'Без команды · Бизнес').textContent, '1');
});

test('editing DS limits preserves existing Go limits and survives reload and JSON round trip', async t => {
  const app = setup(t, {session: member, goBusinessSlots: 7, goTechSlots: 3});
  await app.ready;
  assert.equal(app.$('businessSlots').value, '7');
  assert.equal(app.$('techSlots').value, '3');
  assert.equal(app.$('dsBusinessSlots').value, '3');
  assert.equal(app.$('dsTechSlots').value, '1');
  app.$('dsBusinessSlots').value = '5'; app.$('dsTechSlots').value = '2';
  await app.$('applySettings').onclick();
  const update = app.calls.find(c => c.operation === 'update');
  assert.deepEqual(update.filters, [['id', 'main'], ['version', 1]]);
  assert.equal(update.patch.ds_business_slots, 5); assert.equal(update.patch.ds_tech_slots, 2);
  assert.equal(update.patch.business_slots, 7); assert.equal(update.patch.tech_slots, 3);
  await app.$('reloadCloud').onclick();
  assert.equal(capacityCell(app, 'DS · Бизнес').textContent, '1 / 5');
  assert.equal(capacityCell(app, 'Go · Бизнес').textContent, '0 / 7');
  const exported = await exportedData(app);
  assert.equal(exported.settings.dsBusinessSlots, 5); assert.equal(exported.settings.dsTechSlots, 2);
  Object.defineProperty(app.$('jsonFile'), 'files', {value: [{text: async () => JSON.stringify(exported)}]});
  await app.$('jsonFile').onchange();
  assert.equal(capacityCell(app, 'DS · Бизнес').textContent, '1 / 5');
  assert.equal(capacityCell(app, 'DS · Технические').textContent, '0 / 2');
  assert.equal(capacityCell(app, 'Go · Бизнес').textContent, '0 / 7');
});

test('old database uses DS 3/1 without writing missing columns and keeps Go settings editable', async t => {
  const app = setup(t, {session: member, dsCapacityAvailable: false, goBusinessSlots: 6, goTechSlots: 3});
  await app.ready;
  assert.equal(capacityCell(app, 'DS · Бизнес').textContent, '1 / 3');
  assert.equal(capacityCell(app, 'DS · Технические').textContent, '0 / 1');
  assert.equal(capacityCell(app, 'Go · Бизнес').textContent, '0 / 6');
  assert.equal(app.$('dsBusinessSlots').disabled, true);
  assert.equal(app.$('dsCapacityHint').hidden, false);
  app.$('quarters').value = '3'; app.$('businessSlots').value = '8';
  await app.$('applySettings').onclick();
  const update = app.calls.find(c => c.operation === 'update');
  assert.equal(update.patch.quarters, 3); assert.equal(update.patch.business_slots, 8);
  assert.equal('ds_business_slots' in update.patch, false);
  assert.equal('ds_tech_slots' in update.patch, false);
  assert.equal(capacityCell(app, 'DS · Бизнес').textContent, '1 / 3');
  assert.equal(capacityCell(app, 'Go · Бизнес').textContent, '0 / 8');
});

test('old JSON without DS limits imports with the 3/1 defaults', async t => {
  const app = setup(t, {session: member, dsBusinessSlots: 5, dsTechSlots: 2});
  await app.ready;
  const old = await exportedData(app); delete old.settings.dsBusinessSlots; delete old.settings.dsTechSlots;
  Object.defineProperty(app.$('jsonFile'), 'files', {value: [{text: async () => JSON.stringify(old)}]});
  await app.$('jsonFile').onchange();
  assert.equal(app.$('dsBusinessSlots').value, '3');
  assert.equal(app.$('dsTechSlots').value, '1');
  assert.equal(capacityCell(app, 'Go · Технические').textContent, '1 / 2');
});

test('invalid DS limits are rejected before a settings write or destructive import', async t => {
  const app = setup(t, {session: member});
  await app.ready;
  app.$('dsTechSlots').value = '0'; await app.$('applySettings').onclick();
  app.$('dsTechSlots').value = '1.5'; await app.$('applySettings').onclick();
  assert.equal(app.calls.filter(c => c.operation !== 'select').length, 0);
  const imported = await exportedData(app); imported.settings.dsBusinessSlots = -1;
  Object.defineProperty(app.$('jsonFile'), 'files', {value: [{text: async () => JSON.stringify(imported)}]});
  const errors = []; app.w.alert = message => errors.push(message); app.w.console.error = () => {};
  await app.$('jsonFile').onchange();
  assert.match(errors[0], /от 1 до 20/);
  assert.equal(app.calls.filter(c => c.operation !== 'select').length, 0);
});

test('public documents discourage indexing and contain no bundled roadmap', () => {
  assert.doesNotMatch(html, /id="initial-data"/);
  for (const file of ['index.html', '404.html']) {
    const document = new JSDOM(fs.readFileSync(path.join(root, file), 'utf8')).window.document;
    assert.match(document.querySelector('meta[name="robots"]').content, /noindex/);
  }
  assert.match(fs.readFileSync(path.join(root, 'robots.txt'), 'utf8'), /User-agent: \*\s+Disallow: \//);
});
