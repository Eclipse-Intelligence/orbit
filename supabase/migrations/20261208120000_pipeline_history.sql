create index if not exists audit_events_stage_changed_idx
  on crm.audit_events (workspace_id, entity_id, created_at desc)
  where entity_type = 'opportunity' and event_type = 'opportunity.stage_changed';
