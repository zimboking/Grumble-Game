-- Security tests. Each check signs in as a different person and proves what
-- they can and cannot do. Everything runs in one transaction that is rolled
-- back, so it leaves no data behind.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/policies.sql
--
-- A failed check stops the script with an error. Reaching "ALL CHECKS PASSED"
-- means every check held.

begin;

create schema t;
grant usage on schema t to anon, authenticated;

create function t.ok(cond boolean, name text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAILED: %', name; end if;
  raise notice 'ok - %', name;
end $$;

-- Passes only if the statement is refused.
create function t.refused(stmt text, name text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'ok - % (%)', name, sqlerrm;
    return;
  end;
  raise exception 'FAILED (was allowed): %', name;
end $$;

create function t.login(uid text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;

create temp table ids (name text primary key, id text);
insert into ids values
  ('host', '00000000-0000-4000-8000-000000000001'),
  ('ann',  '00000000-0000-4000-8000-00000000000a'),
  ('bob',  '00000000-0000-4000-8000-00000000000b'),
  ('eve',  '00000000-0000-4000-8000-00000000000e');
grant select on ids to authenticated, anon;
create temp table ctx (code text);
grant all on ctx to authenticated;

-- ---- Not signed in: nothing works ----
set local role anon;
select t.refused('select public.create_room()', 'anon cannot create a room');
select t.refused('select * from public.rooms', 'anon cannot read rooms');
select t.refused('select * from public.grumble_votes', 'anon cannot read votes');
reset role;

-- ---- Host starts a room ----
select t.login((select id from ids where name = 'host'));
insert into ctx select public.create_room();
select t.ok((select code ~ '^[A-HJKMNP-Z]{4}$' from ctx), 'room code is 4 letters with no I, L or O');
reset role;

-- ---- Players join ----
select t.login((select id from ids where name = 'ann'));
select public.join_room((select code from ctx), '  Ann  ');
select t.refused($$select public.join_room('QQQQ', 'Ann')$$, 'cannot join a room that does not exist');
select t.refused(format($$select public.join_room(%L, 'a name that is far too long')$$, (select code from ctx)),
  'nickname over 16 characters is refused');
reset role;
select t.login((select id from ids where name = 'bob'));
select public.join_room((select code from ctx), 'Bob');
select t.ok((select count(*) = 2 from public.players), 'a player sees the players in their room');
select t.ok((select nickname = 'Ann' from public.players where user_id::text = (select id from ids where name = 'ann')),
  'nickname is trimmed');

-- ---- Players cannot touch tables directly ----
select t.refused($$update public.players set score = 99999$$, 'player cannot change scores');
select t.refused(format($$insert into public.players values (%L, gen_random_uuid(), 'Fake', 5000)$$, (select code from ctx)),
  'player cannot insert player rows');
select t.refused($$update public.rooms set revealed = true$$, 'player cannot change the room');
select t.refused($$insert into public.rooms (code, host_id) values ('ABCD', gen_random_uuid())$$,
  'player cannot insert rooms directly');
delete from public.rooms;
select t.ok((select count(*) = 1 from public.rooms), 'player cannot delete the room');
select t.refused($$select * from public.quiz_answers$$, 'player cannot read quiz answers');
select t.refused($$select * from public.grumble_votes$$, 'player cannot read grumble votes');
select t.refused($$insert into public.grumble_votes values ('ABCD', 0, gen_random_uuid(), 5)$$,
  'player cannot write votes directly');
select t.refused(format($$select public.go_to(%L, 'summary', 0, false)$$, (select code from ctx)),
  'player cannot move the game on');
select t.refused(format($$select public.reveal(%L, 1)$$, (select code from ctx)), 'player cannot reveal');
reset role;

-- ---- Outsider sees no players ----
select t.login((select id from ids where name = 'eve'));
select t.ok((select count(*) = 0 from public.players), 'outsider sees no players');
select t.refused(format($$select * from public.vote_progress(%L)$$, (select code from ctx)),
  'outsider cannot see vote progress');
select t.refused(format($$select public.answer_quiz(%L, 1)$$, (select code from ctx)),
  'outsider cannot answer');
reset role;

-- ---- Quiz ----
select t.login((select id from ids where name = 'ann'));
select t.refused(format($$select public.answer_quiz(%L, 1)$$, (select code from ctx)),
  'cannot answer before the quiz starts');
reset role;
select t.login((select id from ids where name = 'host'));
select public.go_to((select code from ctx), 'quiz', 0, false);
reset role;

select t.login((select id from ids where name = 'ann'));
select public.answer_quiz((select code from ctx), 1);
select public.answer_quiz((select code from ctx), 3);
select t.ok((select (public.player_state((select code from ctx)) ->> 'my_answer')::int = 1),
  'first quiz answer locks in');
select t.ok((select answered = 1 and total = 2 from public.vote_progress((select code from ctx))),
  'progress shows 1 of 2');
select t.ok((select public.player_state((select code from ctx)) -> 'my_points' = 'null'::jsonb),
  'points are hidden before reveal');
select t.refused(format($$select public.quiz_counts(%L, 0)$$, (select code from ctx)),
  'player cannot get quiz counts');
reset role;
select t.login((select id from ids where name = 'bob'));
select public.answer_quiz((select code from ctx), 2);
reset role;

select t.login((select id from ids where name = 'host'));
select t.refused(format($$select public.quiz_counts(%L, 0)$$, (select code from ctx)),
  'host cannot get quiz counts before reveal');
select t.ok((select public.host_state() -> 'counts' = 'null'::jsonb), 'host state has no counts before reveal');
select t.ok((select public.host_state() #>> '{progress,answered}' = '2'), 'host sees 2 answered');
reset role;

-- Pretend Ann took 4.5 seconds and Bob took 30 (superuser only, for the test).
update public.quiz_answers a set answered_at = r.question_started_at + interval '4.5 seconds'
  from public.rooms r where r.code = a.room_code and a.option = 1;
update public.quiz_answers a set answered_at = r.question_started_at + interval '30 seconds', option = 1
  from public.rooms r where r.code = a.room_code and a.user_id::text = (select id from ids where name = 'bob');

select t.login((select id from ids where name = 'host'));
select t.refused(format($$select public.reveal(%L)$$, (select code from ctx)), 'quiz reveal needs the correct option');
select public.reveal((select code from ctx), 1);
select t.ok((select public.quiz_counts((select code from ctx), 0) = array[0, 2, 0, 0]), 'quiz counts after reveal');
select t.ok((select score = 900 from public.players where nickname = 'Ann'), '4.5 seconds scores 900');
select t.ok((select score = 500 from public.players where nickname = 'Bob'), '30 seconds scores the 500 floor');
select public.reveal((select code from ctx), 1);
select t.ok((select score = 900 from public.players where nickname = 'Ann'), 'revealing twice does not score twice');
reset role;

select t.login((select id from ids where name = 'ann'));
select t.refused(format($$select public.answer_quiz(%L, 0)$$, (select code from ctx)), 'cannot answer after reveal');
select t.ok((select (public.player_state((select code from ctx)) ->> 'my_points')::int = 900), 'player sees own points after reveal');
reset role;

-- A wrong answer scores 0.
select t.login((select id from ids where name = 'host'));
select public.go_to((select code from ctx), 'quiz', 1, false);
reset role;
select t.login((select id from ids where name = 'ann'));
select public.answer_quiz((select code from ctx), 0);
reset role;
select t.login((select id from ids where name = 'host'));
select public.reveal((select code from ctx), 2);
select t.ok((select score = 900 from public.players where nickname = 'Ann'), 'wrong answer adds 0');
select t.ok((select public.quiz_counts((select code from ctx), 1) = array[1, 0, 0, 0]), 'counts for question 2');

-- ---- Grumble-o-meter ----
select public.go_to((select code from ctx), 'grumble', 0, false);
reset role;

select t.login((select id from ids where name = 'ann'));
select public.vote_grumble((select code from ctx), 5);
select public.vote_grumble((select code from ctx), 4);
select t.ok((select (public.player_state((select code from ctx)) ->> 'my_vote')::int = 4), 'a vote can change before reveal');
select t.refused(format($$select public.vote_grumble(%L, 6)$$, (select code from ctx)), 'vote must be 1 to 5');
select t.refused(format($$select public.grumble_counts(%L, 0)$$, (select code from ctx)), 'player cannot get grumble counts');
select t.refused(format($$select * from public.grumble_summary(%L)$$, (select code from ctx)), 'player cannot get the summary');
reset role;
select t.login((select id from ids where name = 'bob'));
select public.vote_grumble((select code from ctx), 2);
select t.ok((select public.player_state((select code from ctx))::text not like '%' || (select id from ids where name = 'ann') || '%'),
  'player state never mentions another player');
reset role;

select t.login((select id from ids where name = 'host'));
select t.refused(format($$select public.grumble_counts(%L, 0)$$, (select code from ctx)),
  'host cannot get grumble counts before reveal');
select t.refused($$select * from public.grumble_votes$$, 'host cannot read vote rows');
select t.refused(format($$select * from public.grumble_summary(%L)$$, (select code from ctx)),
  'no summary before the summary screen');
select t.ok((select public.host_state() -> 'counts' = 'null'::jsonb), 'host state hides grumble counts before reveal');
select t.ok((select public.host_state() #>> '{progress,answered}' = '2'), 'host sees 2 of 2 voted');
select public.reveal((select code from ctx));
select t.ok((select public.grumble_counts((select code from ctx), 0) = array[0, 1, 0, 1, 0]), 'grumble counts after reveal');
select t.ok((select public.host_state() -> 'counts' = '[0,1,0,1,0]'::jsonb), 'host state has totals after reveal');
reset role;

select t.login((select id from ids where name = 'ann'));
select t.refused(format($$select public.vote_grumble(%L, 1)$$, (select code from ctx)), 'cannot vote after reveal');
reset role;

select t.login((select id from ids where name = 'host'));
select public.go_to((select code from ctx), 'summary', 0, false);
select t.ok((select average = 3.00 and votes = 2 and counts = array[0, 1, 0, 1, 0]
             from public.grumble_summary((select code from ctx)) where idx = 0), 'summary gives average and totals');
select t.ok((select public.host_state()::text not like '%' || (select id from ids where name = 'ann') || '%'
             or public.host_state() -> 'players' is not null), 'host state loads on summary');
select t.ok((select jsonb_typeof(public.host_state() #> '{summary,0,counts}') = 'array'
             and not (public.host_state() #> '{summary,0}') ? 'user_id'), 'summary rows carry totals, not people');

-- ---- A second host cannot touch this room ----
reset role;
select t.login((select id from ids where name = 'eve'));
select t.refused(format($$select public.go_to(%L, 'lobby', 0, false)$$, (select code from ctx)), 'another user cannot run the room');
select t.refused(format($$select public.grumble_counts(%L, 0)$$, (select code from ctx)), 'another user cannot get totals');
delete from public.rooms;
reset role;
select t.ok((select count(*) = 1 from public.rooms), 'another user cannot delete the room');

-- ---- End session removes everything ----
select t.login((select id from ids where name = 'host'));
delete from public.rooms where code = (select code from ctx);
reset role;
select t.ok((select count(*) = 0 from public.rooms), 'room is gone');
select t.ok((select count(*) = 0 from public.players), 'players are gone');
select t.ok((select count(*) = 0 from public.quiz_answers), 'quiz answers are gone');
select t.ok((select count(*) = 0 from public.grumble_votes), 'grumble votes are gone');

-- ---- Realtime never carries answers or votes ----
select t.ok(not exists (
  select 1 from pg_publication_tables
  where schemaname = 'public' and tablename in ('quiz_answers', 'grumble_votes')), 'answers and votes are not in any publication');

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;
rollback;
