-- Separate full administrators from city-only editors.
-- Only the explicitly identified account below becomes a full administrator.
-- Existing users keep their city-editor access; newly created users are not admins.

create table if not exists public.city_directory_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.city_directory_admins enable row level security;
revoke all on public.city_directory_admins from anon, authenticated;

do $
declare
  target_user_id uuid;
begin
  select id
    into target_user_id
  from auth.users
  where lower(email) = lower('pereiradanielc54@gmail.com')
  limit 1;

  if target_user_id is null then
    raise exception 'ADM account pereiradanielc54@gmail.com was not found in Supabase Auth. Create/sign in to this account first, then rerun this migration.';
  end if;

  -- Ensure the selected ADM account is authorized to use the panel.
  insert into public.city_directory_editors (user_id)
  values (target_user_id)
  on conflict (user_id) do nothing;

  -- Grant full administrator role only to the selected account.
  insert into public.city_directory_admins (user_id)
  values (target_user_id)
  on conflict (user_id) do nothing;
end;
$;

create or replace function public.city_directory_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.city_directory_admins
    where user_id = auth.uid()
  );
$$;

revoke all on function public.city_directory_is_admin() from public;
grant execute on function public.city_directory_is_admin() to authenticated;

create or replace function public.guard_city_directory_branch_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_branches jsonb;
  new_branches jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required to modify city directory';
  end if;

  if exists (
    select 1 from public.city_directory_admins
    where user_id = auth.uid()
  ) then
    return new;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', item->'id', 'name', item->'name')
      order by item->>'id'
    ), '[]'::jsonb
  )
  into old_branches
  from jsonb_array_elements(coalesce(old.records, '[]'::jsonb)) as entries(item);

  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', item->'id', 'name', item->'name')
      order by item->>'id'
    ), '[]'::jsonb
  )
  into new_branches
  from jsonb_array_elements(coalesce(new.records, '[]'::jsonb)) as entries(item);

  if old_branches is distinct from new_branches then
    raise exception 'Only administrators can create, edit, or remove branches';
  end if;

  return new;
end;
$$;

drop trigger if exists city_directory_guard_branch_changes on public.city_directory;
create trigger city_directory_guard_branch_changes
before update of records on public.city_directory
for each row
execute function public.guard_city_directory_branch_changes();
