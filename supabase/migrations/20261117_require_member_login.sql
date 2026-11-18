-- Apply BEFORE publishing the password-protected frontend.
-- Replaces the old public-access policies without changing roadmap data.
begin;

create table if not exists public.roadmap_members (
  roadmap_id text not null,
  user_id uuid not null,
  primary key (roadmap_id, user_id)
);

alter table public.roadmap_members enable row level security;
alter table public.roadmap_settings enable row level security;
alter table public.roadmap_activities enable row level security;

-- Policies are OR-ed by default. Remove all old policies, including anonymous
-- ones, before installing membership-only access. Safe to run again.
do $$
declare old_policy record;
begin
  for old_policy in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('roadmap_members', 'roadmap_settings', 'roadmap_activities')
  loop
    execute format('drop policy %I on %I.%I',
      old_policy.policyname, old_policy.schemaname, old_policy.tablename);
  end loop;
end $$;

revoke all on public.roadmap_members, public.roadmap_settings,
  public.roadmap_activities from public, anon, authenticated;

-- Users may see their membership, but may never grant themselves access.
grant select on public.roadmap_members to authenticated;
create policy members_read_self on public.roadmap_members
  for select to authenticated using (user_id = (select auth.uid()));

grant select, update on public.roadmap_settings to authenticated;
grant select, insert, update, delete on public.roadmap_activities to authenticated;

-- Keep a restrictive guard as well: adding another permissive policy later
-- must not accidentally reopen these tables to all signed-in users.
create policy settings_member_guard on public.roadmap_settings
  as restrictive for all to authenticated
  using (exists (
    select 1 from public.roadmap_members m
    where m.roadmap_id = id and m.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.roadmap_members m
    where m.roadmap_id = id and m.user_id = (select auth.uid())
  ));
create policy settings_member_access on public.roadmap_settings
  for all to authenticated using (true) with check (true);

create policy activities_member_guard on public.roadmap_activities
  as restrictive for all to authenticated
  using (exists (
    select 1 from public.roadmap_members m
    where m.roadmap_id = roadmap_activities.roadmap_id
      and m.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.roadmap_members m
    where m.roadmap_id = roadmap_activities.roadmap_id
      and m.user_id = (select auth.uid())
  ));
create policy activities_member_access on public.roadmap_activities
  for all to authenticated using (true) with check (true);

commit;
