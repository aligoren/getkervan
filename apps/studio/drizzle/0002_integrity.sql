-- INSERT OR REPLACE deletes the conflicting row without firing DELETE triggers, so the
-- immutable tables also refuse an insert over an existing id.
CREATE TRIGGER `spec_versions_no_replace` BEFORE INSERT ON `spec_versions`
WHEN EXISTS (SELECT 1 FROM `spec_versions` WHERE `id` = NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'spec versions are immutable');
END;
--> statement-breakpoint
-- A version is only deleted together with its server (the foreign key cascade runs after the
-- server row is gone).
CREATE TRIGGER `spec_versions_no_delete` BEFORE DELETE ON `spec_versions`
WHEN EXISTS (SELECT 1 FROM `servers` WHERE `id` = OLD.`server_id`)
BEGIN
  SELECT RAISE(ABORT, 'spec versions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_replace` BEFORE INSERT ON `audit_events`
WHEN NEW.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM `audit_events` WHERE `id` = NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
