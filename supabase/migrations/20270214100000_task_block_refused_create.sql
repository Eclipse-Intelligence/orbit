set lock_timeout = '5s';

drop function if exists private.defer_task_block(uuid, timestamptz, boolean);
create or replace function private.defer_task_block(p_task_id uuid, p_pending_at timestamptz, p_refused boolean, p_refused_key uuid default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update crm.task_outlook_queue
  set claimed_at = null,
      attempts = case when pending_at = p_pending_at then attempts + 1 else attempts end,
      refused = case when pending_at = p_pending_at then p_refused else refused end,
      retry_at = case
        when pending_at <> p_pending_at then retry_at
        when p_refused then 'infinity'::timestamptz
        else clock_timestamp() + least(interval '6 hours', interval '1 minute' * power(2, least(attempts, 12)))
      end,
      create_key = case when create_key = p_refused_key then null else create_key end,
      create_user_id = case when create_key = p_refused_key then null else create_user_id end,
      create_sent_at = case when create_key = p_refused_key then null else create_sent_at end
  where task_id = p_task_id;
$$;

revoke all on function private.defer_task_block(uuid, timestamptz, boolean, uuid) from public;
grant execute on function private.defer_task_block(uuid, timestamptz, boolean, uuid) to crm_app;
