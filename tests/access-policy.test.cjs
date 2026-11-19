const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('@electric-sql/pglite');

test('real PostgreSQL grants and RLS reject anonymous, non-member and cross-roadmap access', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261117_require_member_login.sql'), 'utf8');
  const linksMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261119_add_activity_links.sql'), 'utf8');
  const capacityMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261119_split_team_capacity.sql'), 'utf8');
  const member = '11111111-1111-4111-8111-111111111111';
  const outsider = '22222222-2222-4222-8222-222222222222';
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    create table public.roadmap_settings (id text primary key, quarters integer, business_slots integer, tech_slots integer);
    create table public.roadmap_activities (id text primary key, roadmap_id text, name text);
    insert into public.roadmap_settings values ('main', 1, 7, 3), ('other', 2, 4, 2);
    insert into public.roadmap_activities values ('a1', 'main', 'Member data'), ('a2', 'other', 'Other data');
    grant all on public.roadmap_settings, public.roadmap_activities to anon, authenticated;
    alter table public.roadmap_settings enable row level security;
    alter table public.roadmap_activities enable row level security;
    create policy old_public_access on public.roadmap_settings for all using (true) with check (true);
    create policy old_public_access on public.roadmap_activities for all using (true) with check (true);
  `);
  await db.exec(migration);
  await db.exec(linksMigration);
  await db.exec(linksMigration);
  await db.exec(capacityMigration);
  await db.exec(capacityMigration);
  assert.deepEqual((await db.query("select business_slots, tech_slots, ds_business_slots, ds_tech_slots from public.roadmap_settings where id = 'main'")).rows,
    [{business_slots: 7, tech_slots: 3, ds_business_slots: 3, ds_tech_slots: 1}]);
  await assert.rejects(db.query('update public.roadmap_settings set ds_business_slots = 0'), /check constraint/);
  await assert.rejects(db.query('update public.roadmap_settings set ds_tech_slots = 21'), /check constraint/);
  await assert.rejects(db.query('update public.roadmap_settings set ds_tech_slots = null'), /not-null constraint/);
  assert.deepEqual((await db.query("select activity_links from public.roadmap_settings where id = 'main'")).rows, [{activity_links: []}]);
  await assert.rejects(db.query("update public.roadmap_settings set activity_links = '{}'"), /check constraint/);
  await assert.rejects(db.query('update public.roadmap_settings set activity_links = null'), /not-null constraint/);
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
    await assert.rejects(db.query("update public.roadmap_settings set activity_links = '[]'"), /permission denied/);
    await assert.rejects(db.query('update public.roadmap_settings set ds_business_slots = 5'), /permission denied/);
  });
  await as('authenticated', outsider, async () => {
    assert.deepEqual((await db.query('select id from public.roadmap_settings')).rows, []);
    assert.deepEqual((await db.query('select id from public.roadmap_activities')).rows, []);
    assert.deepEqual((await db.query('select user_id from public.roadmap_members')).rows, []);
    await assert.rejects(db.query("insert into public.roadmap_activities values ('outsider', 'main', 'Forbidden')"), /row-level security/);
    await assert.rejects(db.query('insert into public.roadmap_members values ($1, $2)', ['main', outsider]), /permission denied/);
    assert.deepEqual((await db.query("update public.roadmap_activities set name = 'Forbidden' returning id")).rows, []);
    assert.deepEqual((await db.query("update public.roadmap_settings set activity_links = '[]' returning id")).rows, []);
    assert.deepEqual((await db.query('update public.roadmap_settings set ds_business_slots = 5 returning id')).rows, []);
  });
  await as('authenticated', member, async () => {
    assert.deepEqual((await db.query('select id from public.roadmap_settings')).rows, [{id: 'main'}]);
    assert.deepEqual((await db.query('select id from public.roadmap_activities')).rows, [{id: 'a1'}]);
    assert.deepEqual((await db.query('select user_id from public.roadmap_members')).rows, [{user_id: member}]);
    await db.query("insert into public.roadmap_activities values ('a3', 'main', 'Allowed')");
    await db.query("update public.roadmap_activities set name = 'Edited' where id = 'a3'");
    await db.query("update public.roadmap_settings set quarters = 3 where id = 'main'");
    await db.query("update public.roadmap_settings set ds_business_slots = 5, ds_tech_slots = 2 where id = 'main'");
    assert.deepEqual((await db.query("update public.roadmap_settings set ds_business_slots = 5 where id = 'other' returning id")).rows, []);
    await db.query('update public.roadmap_settings set activity_links = $1 where id = $2', [JSON.stringify([{from: 'a1', to: 'a3'}]), 'main']);
    assert.deepEqual((await db.query('select activity_links from public.roadmap_settings')).rows, [{activity_links: [{from: 'a1', to: 'a3'}]}]);
    assert.deepEqual((await db.query("update public.roadmap_settings set activity_links = '[]' where id = 'other' returning id")).rows, []);
    await assert.rejects(db.query("insert into public.roadmap_activities values ('a4', 'other', 'Forbidden')"), /row-level security/);
    await assert.rejects(db.query("update public.roadmap_activities set roadmap_id = 'other' where id = 'a3'"), /row-level security/);
    await assert.rejects(db.query("update public.roadmap_settings set id = 'moved' where id = 'main'"), /row-level security/);
    await assert.rejects(db.query('delete from public.roadmap_members'), /permission denied/);
    await assert.rejects(db.query('truncate public.roadmap_activities'), /permission denied/);
    await db.query("delete from public.roadmap_activities where id = 'a3'");
  });
  await db.exec(linksMigration);
  await db.exec(capacityMigration);
  assert.deepEqual((await db.query("select business_slots, tech_slots, ds_business_slots, ds_tech_slots from public.roadmap_settings where id = 'main'")).rows,
    [{business_slots: 7, tech_slots: 3, ds_business_slots: 5, ds_tech_slots: 2}]);
  assert.deepEqual((await db.query("select activity_links from public.roadmap_settings where id = 'main'")).rows, [{activity_links: [{from: 'a1', to: 'a3'}]}]);
});
