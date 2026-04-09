-- Phase 5: encrypted media metadata + Storage bucket (blobs remain ciphertext at rest)

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_path TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS media_iv TEXT;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_media_type_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_media_type_check CHECK (
    media_type IS NULL OR media_type IN ('audio', 'video')
  );

-- Allow media-only rows (text fields nullable when blob-only)
ALTER TABLE public.messages ALTER COLUMN encrypted_content DROP NOT NULL;
ALTER TABLE public.messages ALTER COLUMN iv DROP NOT NULL;

COMMENT ON COLUMN public.messages.media_iv IS 'AES-GCM IV (base64) for the encrypted media blob in Storage';

-- ---------------------------------------------------------------------------
-- Storage: secure_media bucket (RLS still limits to authenticated users)
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('secure_media', 'secure_media', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS secure_media_insert_authenticated ON storage.objects;
DROP POLICY IF EXISTS secure_media_select_authenticated ON storage.objects;

CREATE POLICY secure_media_insert_authenticated
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'secure_media');

CREATE POLICY secure_media_select_authenticated
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'secure_media');
