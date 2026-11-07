-- Run once in Supabase → SQL Editor.

create table if not exists guilds (
  server_id   text primary key,
  channel_id  text,
  sticky_id   text,
  vouch_count integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists vouches (
  id         bigint generated always as identity primary key,
  server_id  text not null references guilds(server_id) on delete cascade,
  author_id  text not null,
  content    text not null,
  created_at timestamptz not null default now()
);

create index if not exists vouches_server_idx on vouches (server_id, created_at desc);

-- logs the vouch and bumps the counter atomically, returns the new total
create or replace function add_vouch(p_server text, p_author text, p_content text)
returns integer
language plpgsql
as $$
declare n integer;
begin
  insert into vouches (server_id, author_id, content) values (p_server, p_author, p_content);
  update guilds set vouch_count = vouch_count + 1 where server_id = p_server returning vouch_count into n;
  return n;
end;
$$;

-- the bot uses the service role key, which bypasses RLS; this locks everyone else out
alter table guilds  enable row level security;
alter table vouches enable row level security;
revoke execute on function add_vouch(text, text, text) from public, anon, authenticated;
