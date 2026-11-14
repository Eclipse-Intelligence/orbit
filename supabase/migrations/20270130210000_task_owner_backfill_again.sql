set lock_timeout = '5s';

with owners as (
  select distinct on (m.workspace_id) m.workspace_id, m.user_id
  from crm.workspace_members m
  where m.role = 'owner'
  order by m.workspace_id, m.created_at, m.user_id
),
assigned as (
  update crm.tasks t
  set owner_id = owners.user_id
  from owners
  where owners.workspace_id = t.workspace_id
    and t.owner_id is null and t.created_by_user_id is null
  returning t.id, t.workspace_id, t.owner_id
)
insert into crm.audit_events (workspace_id, event_type, entity_type, entity_id, actor_type, operation, source, changes)
select assigned.workspace_id, 'task.updated', 'task', assigned.id, 'system', 'assign_ownerless_task_to_owner', 'migration',
  jsonb_build_object('fields', jsonb_build_array('ownerId'), 'before', jsonb_build_object('ownerId', null), 'after', jsonb_build_object('ownerId', assigned.owner_id))
from assigned;

reset lock_timeout;
