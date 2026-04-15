-- ============================================================
-- Stage 6: Vault Server-Side Amputation
-- SAFEGUARD + DROP vault columns from users table
--
-- Run: psql $DATABASE_URL -f this_file.sql
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- [SAFEGUARD] :: Блокировка если есть юзеры без device-записи
-- Такой юзер потеряет vault-blob без возможности восстановления
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*)
    INTO orphan_count
    FROM users u
    LEFT JOIN devices d ON u.id = d.user_id
   WHERE d.id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'STAGE6_BLOCKED: % user(s) have no device record. '
      'Run device migration first, then retry.',
      orphan_count;
  END IF;
END;
$$;

-- ────────────────────────────────────────────────────────────
-- [SAFEGUARD] :: Блокировка если есть юзеры с vault_blob
-- но без linked device (ecdh_public_key IS NULL)
-- Значит Stage 5 fan-out для них ещё не активен
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  unlinked_count INTEGER;
BEGIN
  SELECT COUNT(DISTINCT u.id)
    INTO unlinked_count
    FROM users u
    JOIN devices d ON u.id = d.user_id
   WHERE u.vault_blob IS NOT NULL
     AND d.revoked_at IS NULL
     AND d.ecdh_public_key IS NULL;

  IF unlinked_count > 0 THEN
    RAISE EXCEPTION
      'STAGE6_BLOCKED: % user(s) have vault_blob but no linked ECDH device. '
      'Wait for all active sessions to complete Stage 5 device linking.',
      unlinked_count;
  END IF;
END;
$$;

-- ────────────────────────────────────────────────────────────
-- [DROP] :: Удаляем vault-колонки из таблицы users
-- Отдельная таблица vault не существует — данные хранились
-- в users.vault_blob / vault_version / vault_updated_at
-- ────────────────────────────────────────────────────────────
ALTER TABLE users
  DROP COLUMN IF EXISTS vault_blob,
  DROP COLUMN IF EXISTS vault_version,
  DROP COLUMN IF EXISTS vault_updated_at;

COMMIT;

-- ════════════════════════════════════════════════════════════
-- ROLLBACK PLAN (если что-то пошло не так до коммита):
--   ROLLBACK; — транзакция откатится автоматически
--
-- Восстановление колонок (emergency):
--   ALTER TABLE users
--     ADD COLUMN vault_blob        text,
--     ADD COLUMN vault_version     integer NOT NULL DEFAULT 0,
--     ADD COLUMN vault_updated_at  timestamptz;
-- ════════════════════════════════════════════════════════════
