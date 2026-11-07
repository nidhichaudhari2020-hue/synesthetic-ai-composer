CREATE TABLE `accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library_writes` (
	`owner_id` text NOT NULL,
	`receipt` text NOT NULL,
	`at_ms` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `receipt`),
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `library_writes_owner_time` ON `library_writes` (`owner_id`,`at_ms`);--> statement-breakpoint
CREATE TABLE `tracks` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`owner_id`, `id`),
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tracks_owner_created` ON `tracks` (`owner_id`,`created_at`,`id`);