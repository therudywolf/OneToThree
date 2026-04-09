-- Phase 3: core schema + RLS (E2E ciphertext + keys only — no plaintext policy at rest)
-- Requires: Supabase Auth (auth.users)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE public.users (
  id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  public_key_jwk TEXT NOT NULL
);

CREATE TABLE public.chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_group BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.chat_members (
  chat_id UUID NOT NULL REFERENCES public.chats (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  encrypted_group_key TEXT,
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX chat_members_user_id_idx ON public.chat_members (user_id);
CREATE INDEX chat_members_chat_id_idx ON public.chat_members (chat_id);

CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID NOT NULL REFERENCES public.chats (id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  encrypted_content TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX messages_chat_id_created_at_idx ON public.messages (chat_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- users: profile rows tied to auth; public keys readable by signed-in peers for E2E
CREATE POLICY users_select_authenticated
  ON public.users
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY users_insert_own
  ON public.users
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY users_update_own
  ON public.users
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- chats: visible only if member (avoid recursive RLS on chat_members)
CREATE POLICY chats_select_member
  ON public.chats
  FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT cm.chat_id
      FROM public.chat_members cm
      WHERE cm.user_id = auth.uid()
    )
  );

CREATE POLICY chats_insert_authenticated
  ON public.chats
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- chat_members: readable only for chats the user belongs to
CREATE POLICY chat_members_select_member
  ON public.chat_members
  FOR SELECT
  TO authenticated
  USING (
    chat_id IN (
      SELECT cm.chat_id
      FROM public.chat_members cm
      WHERE cm.user_id = auth.uid()
    )
  );

-- Join self to a chat, or add someone else if already a member
CREATE POLICY chat_members_insert_self_or_member
  ON public.chat_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    OR chat_id IN (
      SELECT cm.chat_id
      FROM public.chat_members cm
      WHERE cm.user_id = auth.uid()
    )
  );

CREATE POLICY chat_members_update_member
  ON public.chat_members
  FOR UPDATE
  TO authenticated
  USING (
    chat_id IN (
      SELECT cm.chat_id
      FROM public.chat_members cm
      WHERE cm.user_id = auth.uid()
    )
  )
  WITH CHECK (
    chat_id IN (
      SELECT cm.chat_id
      FROM public.chat_members cm
      WHERE cm.user_id = auth.uid()
    )
  );

-- messages: read only in member chats; insert only as self and only in member chats
CREATE POLICY messages_select_member
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (
    chat_id IN (
      SELECT cm.chat_id
      FROM public.chat_members cm
      WHERE cm.user_id = auth.uid()
    )
  );

CREATE POLICY messages_insert_member_sender
  ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND chat_id IN (
      SELECT cm.chat_id
      FROM public.chat_members cm
      WHERE cm.user_id = auth.uid()
    )
  );
