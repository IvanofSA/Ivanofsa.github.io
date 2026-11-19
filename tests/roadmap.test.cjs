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

function setup(t, {session = null, denied = false, deferred = false, loginError = false, logoutError = false, settingsError = false, settingsConflict = false, loginDomain = ''} = {}) {
  const dom = new JSDOM(html, {url: 'https://roadmap.example.test/', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const $ = id => w.document.getElementById(id);
  const calls = [], pending = [], authCalls = [];
  let listener, clientOptions;
  const settings = {
    id: 'main', horizon_start: '2026-11-18', quarters: 2, business_slots: 4, tech_slots: 2, version: 1,
    developers: [{id: 'ds', name: 'Data scientist', role: 'DS'}, {id: 'go', name: 'Go developer', role: 'Go'}]
  };
  let activities = [
    {id: 'a1', resource: 'ds', name: 'DS activity', slot: 'One', type: 'Бизнес', qa: 'QA1'},
    {id: 'a2', resource: 'go', name: 'Go activity', slot: 'Two', type: 'Технический', qa: 'QA2'},
    {id: 'a3', resource: 'Legacy', name: 'Vacation', slot: '', type: 'Отпуск', qa: ''}
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
            return {data: structuredClone(activities), error: null};
          };
          const response = execute();
          if (deferred) return new Promise(done => pending.push(() => done(response))).then(resolve, reject);
          return Promise.resolve(response).then(resolve, reject);
        }
      };
      return query;
    },
    channel() {return {on() {return this;}, subscribe() {return this;}};},
    removeChannel: async () => {}
  };
  w.ROADMAP_CONFIG = {supabaseUrl: 'https://backend.example.test', supabaseKey: 'test-only', roadmapId: 'main', loginDomain};
  w.supabase = {createClient(url, key, options) {clientOptions = options; return sb;}};
  w.alert = message => {throw new Error(message);};
  w.confirm = () => true;
  w.localStorage.setItem('roadmap-cloud-cache-v1', JSON.stringify({settings, activities}));
  const ready = w.eval(script);
  return {w, $, calls, authCalls, pending, ready, options: () => clientOptions,
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
  assert.equal(rows[1].querySelector('.cap-cell').textContent, '1 / 4');
  assert.equal(rows[2].querySelector('.cap-cell').textContent, '0 / 2');
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
  assert.match(app.$('roadmapTitle').textContent, /18.11.2026 — 31.03.2027/);
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

test('public documents discourage indexing and contain no bundled roadmap', () => {
  assert.doesNotMatch(html, /id="initial-data"/);
  for (const file of ['index.html', '404.html']) {
    const document = new JSDOM(fs.readFileSync(path.join(root, file), 'utf8')).window.document;
    assert.match(document.querySelector('meta[name="robots"]').content, /noindex/);
  }
  assert.match(fs.readFileSync(path.join(root, 'robots.txt'), 'utf8'), /User-agent: \*\s+Disallow: \//);
});
