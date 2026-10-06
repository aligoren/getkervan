-- Spec versions never change once saved: a new version is a new row.
CREATE TRIGGER `spec_versions_immutable` BEFORE UPDATE ON `spec_versions`
BEGIN
  SELECT RAISE(ABORT, 'spec versions are immutable');
END;
--> statement-breakpoint
-- The audit log is append-only.
CREATE TRIGGER `audit_events_no_update` BEFORE UPDATE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_delete` BEFORE DELETE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
