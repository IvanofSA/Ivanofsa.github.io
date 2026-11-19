-- Run in Supabase SQL Editor before deploying the connections UI.
-- Links are directed pairs of activity IDs: {"from": "...", "to": "..."}.
-- Existing settings RLS, version trigger and realtime subscription apply.
-- No accounts, permissions or existing roadmap data are changed.
begin;

alter table public.roadmap_settings
  add column if not exists activity_links jsonb not null default '[]'::jsonb
  check (jsonb_typeof(activity_links) = 'array');

commit;
