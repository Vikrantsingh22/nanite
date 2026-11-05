ALTER TABLE "arkiv_writes" ADD COLUMN "webhook_event_id" uuid;--> statement-breakpoint
ALTER TABLE "arkiv_writes" ADD COLUMN "mailbox_id" uuid;--> statement-breakpoint
ALTER TABLE "arkiv_writes" ADD CONSTRAINT "arkiv_writes_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arkiv_writes" ADD CONSTRAINT "arkiv_writes_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arkiv_writes" ADD CONSTRAINT "arkiv_writes_event_mailbox_unique" UNIQUE("webhook_event_id","mailbox_id");