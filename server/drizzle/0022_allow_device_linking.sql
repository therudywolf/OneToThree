ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "allow_device_linking" boolean NOT NULL DEFAULT false;
