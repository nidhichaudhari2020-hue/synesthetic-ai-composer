-- Run only as the migration administrator. Never connect the API as this role.
-- Passwords are set by provision.py or local-init.sh, never stored in this file.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'composer_owner') THEN
    CREATE ROLE composer_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
REVOKE composer_owner FROM app_runtime;
GRANT composer_owner TO CURRENT_USER;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO composer_owner;
GRANT USAGE ON SCHEMA public TO app_runtime;
SET ROLE composer_owner;
CREATE TABLE IF NOT EXISTS public.tracks (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 255),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL,
  midi bytea NOT NULL CHECK (octet_length(midi) <= 1048576)
);
CREATE INDEX IF NOT EXISTS tracks_owner_created_idx ON public.tracks (owner_id, created_at DESC);
ALTER TABLE public.tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tracks_owner_policy ON public.tracks;
CREATE POLICY tracks_owner_policy ON public.tracks FOR ALL TO app_runtime
  USING (owner_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), ''));
REVOKE ALL ON public.tracks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tracks TO app_runtime;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM composer_owner;
