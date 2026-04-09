-- Enable Realtime for encrypted message rows (payload remains ciphertext server-side).
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
