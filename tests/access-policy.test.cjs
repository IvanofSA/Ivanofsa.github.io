const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('@electric-sql/pglite');

test('real PostgreSQL grants and RLS reject anonymous, non-member and cross-roadmap access', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261117_require_member_login.sql'), 'utf8');
  const member = '11111111-1111-4111-8111-111111111111';
  const outsider = '22222222-2222-4222-8222-222222222222';
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    create table public.roadmap_settings (id text primary key, quarters integer);
    create table public.roadmap_activities (id text primary key, roadmap_id text, name text);
    insert into public.roadmap_settings values ('main', 1), ('other', 2);
    insert into public.roadmap_activities values ('a1', 'main', 'Member data'), ('a2', 'other', 'Other data');
    grant all on public.roadmap_settings, public.roadmap_activities to anon, authenticated;
    alter table public.roadmap_settings enable row level security;
    alter table public.roadmap_activities enable row level security;
    create policy old_public_access on public.roadmap_settings for all using (true) with check (true);
    create policy old_public_access on public.roadmap_activities for all using (true) with check (true);
  `);
  await db.exec(migration);
  await db.query('insert into public.roadmap_members values ($1, $2)', ['main', member]);
  await db.exec(migration); // Reapplying must preserve data and membership.
  assert.equal((await db.query('select id from public.roadmap_activities')).rows.length, 2);
  assert.equal((await db.query('select user_id from public.roadmap_members')).rows.length, 1);
  // A future permissive policy cannot bypass the restrictive membership guard.
  await db.exec(`create policy accidental_access on public.roadmap_activities for all to authenticated using (true) with check (true)`);

  async function as(role, userId, run) {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    try {await run();} finally {await db.exec('reset role');}
  }
  await as('anon', '', async () => {
    for (const table of ['roadmap_settings', 'roadmap_activities', 'roadmap_members']) {
      await assert.rejects(db.query(`select 1 from public.${table}`), /permission denied/);
      await assert.rejects(db.query(`delete from public.${table}`), /permission denied/);
    }
    await assert.rejects(db.query("insert into public.roadmap_activities values ('anon', 'main', 'Forbidden')"), /permission denied/);
    await assert.rejects(db.query('update public.roadmap_settings set quarters = 8'), /permission denied/);
  });
  await as('authenticated', outsider, async () => {
    assert.deepEqual((await db.query('select id from public.roadmap_settings')).rows, []);
    assert.deepEqual((await db.query('select id from public.roadmap_activities')).rows, []);
    assert.deepEqual((await db.query('select user_id from public.roadmap_members')).rows, []);
    await assert.rejects(db.query("insert into public.roadmap_activities values ('outsider', 'main', 'Forbidden')"), /row-level security/);
    await assert.rejects(db.query('insert into public.roadmap_members values ($1, $2)', ['main', outsider]), /permission denied/);
    assert.deepEqual((await db.query("update public.roadmap_activities set name = 'Forbidden' returning id")).rows, []);
  });
  await as('authenticated', member, async () => {
    assert.deepEqual((await db.query('select id from public.roadmap_settings')).rows, [{id: 'main'}]);
    assert.deepEqual((await db.query('select id from public.roadmap_activities')).rows, [{id: 'a1'}]);
    assert.deepEqual((await db.query('select user_id from public.roadmap_members')).rows, [{user_id: member}]);
    await db.query("insert into public.roadmap_activities values ('a3', 'main', 'Allowed')");
    await db.query("update public.roadmap_activities set name = 'Edited' where id = 'a3'");
    await db.query("update public.roadmap_settings set quarters = 3 where id = 'main'");
    await assert.rejects(db.query("insert into public.roadmap_activities values ('a4', 'other', 'Forbidden')"), /row-level security/);
    await assert.rejects(db.query("update public.roadmap_activities set roadmap_id = 'other' where id = 'a3'"), /row-level security/);
    await assert.rejects(db.query("update public.roadmap_settings set id = 'moved' where id = 'main'"), /row-level security/);
    await assert.rejects(db.query('delete from public.roadmap_members'), /permission denied/);
    await assert.rejects(db.query('truncate public.roadmap_activities'), /permission denied/);
    await db.query("delete from public.roadmap_activities where id = 'a3'");
  });
});
