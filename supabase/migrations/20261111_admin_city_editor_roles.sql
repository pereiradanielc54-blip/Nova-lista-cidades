-- Separate full administrators from city-only editors.
-- Existing authorized editors are promoted once during rollout so the current
-- administrator keeps access. Newly created users are NOT inserted here.

create table if not exists public.city_directory_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.city_directory_admins enable row level security;
revoke all on public.city_directory_admins from anon, authenticated;

insert into public.city_directory_admins (user_id)
select user_id from public.city_directory_editors
on conflict (user_id) do nothing;

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
