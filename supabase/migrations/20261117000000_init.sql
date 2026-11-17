-- Rejoice With Me: tables, row level security, functions and realtime.
--
-- The rule that matters most: nobody can read quiz_answers or grumble_votes.
-- Those tables have row level security on and NO policies, so every direct
-- read or write through the API is refused. All access goes through the
-- functions below, which only ever hand back a person's own answer or totals.

-- ---------------------------------------------------------------- tables --

create table public.rooms (
  code text primary key check (code ~ '^[A-Z]{4}$'),
  host_id uuid not null,
  round text not null default 'lobby'
    check (round in ('lobby', 'quiz', 'leaderboard', 'grumble', 'summary')),
  idx int not null default 0 check (idx >= 0),
  revealed boolean not null default false,
  question_started_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.players (
  room_code text not null references public.rooms on delete cascade,
  user_id uuid not null,
  nickname text not null check (char_length(nickname) between 1 and 16),
  score int not null default 0,
  primary key (room_code, user_id)
);

create table public.quiz_answers (
  room_code text not null references public.rooms on delete cascade,
  question_idx int not null,
  user_id uuid not null,
  option int not null check (option between 0 and 3),
  answered_at timestamptz not null default now(),
  points int,
  primary key (room_code, question_idx, user_id)
);

-- user_id is here only so each person gets one vote per scenario.
-- Nothing ever reads it back out.
create table public.grumble_votes (
  room_code text not null references public.rooms on delete cascade,
  scenario_idx int not null,
  user_id uuid not null,
  value int not null check (value between 1 and 5),
  primary key (room_code, scenario_idx, user_id)
);

create index rooms_host_idx on public.rooms (host_id, created_at desc);

-- ------------------------------------------------------------------- RLS --

alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.quiz_answers enable row level security;
alter table public.grumble_votes enable row level security;

revoke all on public.rooms, public.players, public.quiz_answers, public.grumble_votes
  from anon, authenticated;
grant select, delete on public.rooms to authenticated;
grant select on public.players to authenticated;

-- Helpers. Security definer so policies on players do not recurse.
create function public.is_host(p_room text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from rooms where code = p_room and host_id = auth.uid());
$$;

create function public.is_member(p_room text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from players where room_code = p_room and user_id = auth.uid());
$$;

-- rooms: any signed-in user can read the game state. Only the host can
-- delete. Creating and changing a room goes through functions.
create policy rooms_select on public.rooms
  for select to authenticated using (true);
create policy rooms_delete_host on public.rooms
  for delete to authenticated using (host_id = auth.uid());

-- players: visible to people in the room and to its host. No direct writes.
create policy players_select_room on public.players
  for select to authenticated
  using (public.is_member(room_code) or public.is_host(room_code));

-- quiz_answers and grumble_votes: no policies at all, on purpose.

-- -------------------------------------------------------- host functions --

-- Makes a room with a fresh 4-letter code (no I, L or O). Also clears out
-- any room older than 24 hours, so old votes never linger.
create function public.create_room() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  letters constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ';
  new_code text;
  attempt int := 0;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from rooms where created_at < now() - interval '24 hours';
  delete from rooms where host_id = auth.uid();
  loop
    attempt := attempt + 1;
    select string_agg(substr(letters, 1 + floor(random() * length(letters))::int, 1), '')
      into new_code from generate_series(1, 4);
    begin
      insert into rooms (code, host_id) values (new_code, auth.uid());
      return new_code;
    exception when unique_violation then
      if attempt > 50 then raise exception 'could not find a free room code'; end if;
    end;
  end loop;
end;
$$;

-- Moves the game to a screen. Opening a question stamps the server time.
create function public.go_to(p_room text, p_round text, p_idx int, p_revealed boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_host(p_room) then raise exception 'host only'; end if;
  update rooms set
    round = p_round,
    idx = p_idx,
    revealed = p_revealed,
    question_started_at =
      case when p_round in ('quiz', 'grumble') and not p_revealed then now() else null end
  where code = p_room;
end;
$$;

-- Reveals the current question or scenario. In the quiz it also scores:
-- 1000 points minus 25 per second taken, never below 500. Wrong is 0.
-- Times are server times, so a phone's clock cannot affect the score.
create function public.reveal(p_room text, p_correct int default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r rooms%rowtype;
begin
  select * into r from rooms where code = p_room and host_id = auth.uid() for update;
  if not found then raise exception 'host only'; end if;
  if r.revealed or r.round not in ('quiz', 'grumble') then return; end if;

  if r.round = 'quiz' then
    if p_correct is null or p_correct not between 0 and 3 then
      raise exception 'the correct option is needed to score the quiz';
    end if;
    update quiz_answers a set points =
      case when a.option = p_correct then
        greatest(500, 1000 - 25 * greatest(0,
          floor(extract(epoch from (a.answered_at - coalesce(r.question_started_at, a.answered_at))))::int))
      else 0 end
    where a.room_code = p_room and a.question_idx = r.idx and a.points is null;

    update players p set score = coalesce(
      (select sum(a.points) from quiz_answers a
        where a.room_code = p_room and a.user_id = p.user_id), 0)
    where p.room_code = p_room;
  end if;

  update rooms set revealed = true where code = p_room;
end;
$$;

-- True while an item is the live, unrevealed one. Its totals stay hidden.
create function public.is_live_secret(p_room text, p_round text, p_idx int) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from rooms
    where code = p_room and round = p_round and idx = p_idx and not revealed);
$$;

create function public.quiz_counts(p_room text, p_idx int) returns int[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_host(p_room) then raise exception 'host only'; end if;
  if is_live_secret(p_room, 'quiz', p_idx) then raise exception 'not revealed yet'; end if;
  return array(
    select count(a.user_id)::int
    from generate_series(0, 3) o
    left join quiz_answers a
      on a.room_code = p_room and a.question_idx = p_idx and a.option = o
    group by o order by o);
end;
$$;

create function public.grumble_counts(p_room text, p_idx int) returns int[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_host(p_room) then raise exception 'host only'; end if;
  if is_live_secret(p_room, 'grumble', p_idx) then raise exception 'not revealed yet'; end if;
  return array(
    select count(v.user_id)::int
    from generate_series(1, 5) s
    left join grumble_votes v
      on v.room_code = p_room and v.scenario_idx = p_idx and v.value = s
    group by s order by s);
end;
$$;

-- Average and totals for every scenario. Host only, on the summary screen.
create function public.grumble_summary(p_room text)
returns table (idx int, average numeric, votes int, counts int[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_host(p_room) then raise exception 'host only'; end if;
  if not exists (select 1 from rooms where code = p_room and round = 'summary') then
    raise exception 'only on the summary screen';
  end if;
  return query
    select s.scenario_idx,
           round(avg(s.value), 2),
           count(*)::int,
           array(select count(v.user_id)::int
                 from generate_series(1, 5) g
                 left join grumble_votes v
                   on v.room_code = p_room and v.scenario_idx = s.scenario_idx and v.value = g
                 group by g order by g)
    from grumble_votes s
    where s.room_code = p_room
    group by s.scenario_idx
    order by avg(s.value) desc, s.scenario_idx;
end;
$$;

-- ------------------------------------------------------ shared functions --

-- "7 of 9 voted" for the current screen. A number, never names.
create function public.vote_progress(p_room text)
returns table (answered int, total int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r rooms%rowtype;
begin
  if not (is_host(p_room) or is_member(p_room)) then raise exception 'not in this room'; end if;
  select * into r from rooms where code = p_room;
  total := (select count(*) from players where room_code = p_room);
  answered := case r.round
    when 'quiz' then
      (select count(*) from quiz_answers where room_code = p_room and question_idx = r.idx)
    when 'grumble' then
      (select count(*) from grumble_votes where room_code = p_room and scenario_idx = r.idx)
    else 0 end;
  return next;
end;
$$;

-- ----------------------------------------------------- player functions --

create function public.join_room(p_room text, p_nickname text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  clean text := btrim(regexp_replace(coalesce(p_nickname, ''), '\s+', ' ', 'g'));
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from rooms where code = p_room) then
    raise exception 'room not found';
  end if;
  if char_length(clean) not between 1 and 16 then
    raise exception 'nickname must be 1 to 16 characters';
  end if;
  insert into players (room_code, user_id, nickname)
  values (p_room, auth.uid(), clean)
  on conflict (room_code, user_id) do update set nickname = excluded.nickname;
end;
$$;

-- One answer per question. The first tap locks in.
create function public.answer_quiz(p_room text, p_option int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r rooms%rowtype;
begin
  if not is_member(p_room) then raise exception 'not in this room'; end if;
  select * into r from rooms where code = p_room;
  if r.round <> 'quiz' or r.revealed then raise exception 'answers are closed'; end if;
  insert into quiz_answers (room_code, question_idx, user_id, option)
  values (p_room, r.idx, auth.uid(), p_option)
  on conflict do nothing;
end;
$$;

-- One vote per scenario. It can change until the reveal.
create function public.vote_grumble(p_room text, p_value int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r rooms%rowtype;
begin
  if not is_member(p_room) then raise exception 'not in this room'; end if;
  select * into r from rooms where code = p_room;
  if r.round <> 'grumble' or r.revealed then raise exception 'voting is closed'; end if;
  insert into grumble_votes (room_code, scenario_idx, user_id, value)
  values (p_room, r.idx, auth.uid(), p_value)
  on conflict (room_code, scenario_idx, user_id) do update set value = excluded.value;
end;
$$;

create function public.room_json(r public.rooms) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'code', r.code, 'round', r.round, 'idx', r.idx, 'revealed', r.revealed,
    'question_started_at', r.question_started_at, 'server_now', now());
$$;

-- Everything one phone needs, in one request: the room, this player, and
-- this player's OWN answer for the current screen. Never anyone else's.
create function public.player_state(p_room text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r rooms%rowtype;
  me players%rowtype;
  a quiz_answers%rowtype;
  my_vote int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from rooms where code = p_room;
  if not found then return jsonb_build_object('room', null, 'me', null); end if;
  select * into me from players where room_code = p_room and user_id = auth.uid();
  if not found then
    return jsonb_build_object('room', public.room_json(r), 'me', null);
  end if;
  if r.round = 'quiz' then
    select * into a from quiz_answers
      where room_code = p_room and question_idx = r.idx and user_id = auth.uid();
  elsif r.round = 'grumble' then
    select value into my_vote from grumble_votes
      where room_code = p_room and scenario_idx = r.idx and user_id = auth.uid();
  end if;
  return jsonb_build_object(
    'room', public.room_json(r),
    'me', jsonb_build_object('id', me.user_id, 'nickname', me.nickname, 'score', me.score),
    'my_answer', a.option,
    'my_points', case when r.revealed and r.round = 'quiz' then coalesce(a.points, 0) end,
    'my_vote', my_vote);
end;
$$;

-- Everything the host screen needs, in one request. Totals only.
create function public.host_state() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r rooms%rowtype;
  prog record;
  counts int[];
  summary jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from rooms where host_id = auth.uid() order by created_at desc limit 1;
  if not found then return jsonb_build_object('room', null); end if;
  select * into prog from vote_progress(r.code);
  if r.revealed and r.round = 'quiz' then counts := quiz_counts(r.code, r.idx);
  elsif r.revealed and r.round = 'grumble' then counts := grumble_counts(r.code, r.idx);
  end if;
  if r.round = 'summary' then
    select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into summary
    from grumble_summary(r.code) s;
  end if;
  return jsonb_build_object(
    'room', public.room_json(r),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', p.user_id, 'nickname', p.nickname, 'score', p.score)
                  order by p.nickname), '[]'::jsonb)
                from players p where p.room_code = r.code),
    'progress', jsonb_build_object('answered', prog.answered, 'total', prog.total),
    'counts', to_jsonb(counts),
    'summary', summary);
end;
$$;

-- Only signed-in users may call these. Anonymous sign-in counts as signed in.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;

-- -------------------------------------------------------------- realtime --

-- Only game state and the lobby list are broadcast. Answers and votes are
-- never added here, because that would send raw rows to every phone.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.rooms, public.players;
  end if;
end $$;
