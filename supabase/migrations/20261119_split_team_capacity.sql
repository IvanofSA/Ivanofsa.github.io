-- DS and Go share a roadmap, but have independent capacity limits.
-- Existing business_slots / tech_slots now describe Go and keep their values.
-- Without this migration the frontend already uses DS defaults of 3 / 1;
-- applying it enables editing and saving those limits through the UI.
-- Existing settings RLS, version trigger and realtime subscription apply.
begin;

alter table public.roadmap_settings
  add column if not exists ds_business_slots integer not null default 3
    check (ds_business_slots between 1 and 20),
  add column if not exists ds_tech_slots integer not null default 1
    check (ds_tech_slots between 1 and 20);

commit;
