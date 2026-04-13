-- Shadow protocol: new accounts are hidden from username search unless they opt in.
ALTER TABLE "users" ALTER COLUMN "is_discoverable" SET DEFAULT false;
