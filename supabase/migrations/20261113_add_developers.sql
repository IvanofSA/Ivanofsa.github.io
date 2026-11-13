-- Run once in the Supabase SQL Editor before deploying the updated frontend.
-- Existing activities retain their resource values as stable developer IDs.
-- The existing settings RLS policies, version trigger and realtime subscription apply.
begin;

alter table public.roadmap_settings
  add column if not exists developers jsonb not null default '[]'::jsonb
  check (jsonb_typeof(developers) = 'array');

commit;
