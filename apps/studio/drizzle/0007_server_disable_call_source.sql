ALTER TABLE `call_logs` ADD `source` text;--> statement-breakpoint
ALTER TABLE `call_logs` ADD `api_key_id` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `disabled_at` integer;