CREATE TABLE `version_checks` (
	`version_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`valid` integer NOT NULL,
	`problems` integer NOT NULL,
	`secrets` integer NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `spec_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `ip` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_agent` text;--> statement-breakpoint
ALTER TABLE `users` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_login_at` integer;