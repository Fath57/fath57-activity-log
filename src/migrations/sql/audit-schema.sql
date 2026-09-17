CREATE SCHEMA IF NOT EXISTS audit;

DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_admin') THEN 
        CREATE ROLE audit_admin NOLOGIN; 
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_bypass') THEN 
        CREATE ROLE audit_bypass NOLOGIN; 
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS audit.logged_actions (
    event_id          BIGSERIAL,
    schema_name       TEXT NOT NULL,
    table_name        TEXT NOT NULL,
    row_id            TEXT NOT NULL,
    row_id_is_json    BOOLEAN NOT NULL DEFAULT false,
    action            CHAR(1) NOT NULL CHECK (action IN ('I', 'U', 'D')),
    old_data          JSONB,
    new_data          JSONB,
    changed_fields    JSONB,
    changed_by        TEXT,
    session_user_name TEXT NOT NULL DEFAULT SESSION_USER,
    client_addr       INET DEFAULT inet_client_addr(),
    bypass_attempted  BOOLEAN NOT NULL DEFAULT false,
    client_query      TEXT,
    transaction_id    XID8 NOT NULL DEFAULT pg_current_xact_id(),
    changed_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (event_id, changed_at)
) PARTITION BY RANGE (changed_at);

CREATE TABLE IF NOT EXISTS audit.logged_actions_default
    PARTITION OF audit.logged_actions DEFAULT;

CREATE INDEX IF NOT EXISTS idx_logged_actions_default_time
    ON audit.logged_actions_default (changed_at);

CREATE INDEX IF NOT EXISTS idx_logged_actions_target 
    ON audit.logged_actions (schema_name, table_name, row_id);

CREATE INDEX IF NOT EXISTS idx_logged_actions_user 
    ON audit.logged_actions (changed_by) WHERE changed_by IS NOT NULL;

CREATE OR REPLACE FUNCTION audit.log_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_old_data       JSONB := NULL;
    v_new_data       JSONB := NULL;
    v_diff           JSONB := NULL;
    v_data           JSONB;
    v_row_id         TEXT;
    v_row_id_is_json BOOLEAN := false;
    v_pk_cols        TEXT[]  := COALESCE(TG_ARGV[0]::TEXT[], ARRAY['id']::TEXT[]);
    v_ignored_cols   TEXT[]  := COALESCE(TG_ARGV[1]::TEXT[], ARRAY[]::TEXT[]);
    v_capture_query  BOOLEAN := COALESCE(TG_ARGV[2]::BOOLEAN, false);
    v_query          TEXT := NULL;
    v_bypass_denied  BOOLEAN := false;
    v_may_bypass     BOOLEAN := false;
BEGIN
    IF LOWER(COALESCE(current_setting('audit.disabled', true), 'off')) IN ('on', '1', 'true') THEN
        BEGIN
            v_may_bypass := pg_has_role(SESSION_USER, 'audit_bypass', 'MEMBER');
        EXCEPTION WHEN undefined_object THEN
            v_may_bypass := false;
        END;

        IF v_may_bypass THEN
            IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
        END IF;

        v_bypass_denied := true;
    END IF;

    IF v_capture_query THEN
        v_query := left(current_query(), 2048);
    END IF;

    IF (TG_OP = 'INSERT') THEN
        v_new_data := to_jsonb(NEW) - v_ignored_cols;
        v_data     := v_new_data;

    ELSIF (TG_OP = 'UPDATE') THEN
        v_old_data := to_jsonb(OLD) - v_ignored_cols;
        v_new_data := to_jsonb(NEW) - v_ignored_cols;
        v_data     := v_new_data;

        SELECT jsonb_object_agg(n.key, n.value)
        INTO   v_diff
        FROM   jsonb_each(v_new_data) n
        WHERE  n.value IS DISTINCT FROM (v_old_data -> n.key);

        IF v_diff IS NULL OR v_diff = '{}'::jsonb THEN
            RETURN NEW;
        END IF;

    ELSIF (TG_OP = 'DELETE') THEN
        v_old_data := to_jsonb(OLD) - v_ignored_cols;
        v_data     := v_old_data;
    END IF;

    IF array_length(v_pk_cols, 1) = 1 THEN
        v_row_id := v_data ->> v_pk_cols[1];
    ELSE
        SELECT jsonb_object_agg(k, v_data -> k)::text
        INTO   v_row_id
        FROM   unnest(v_pk_cols) k;
        v_row_id_is_json := true;
    END IF;

    IF v_row_id IS NULL THEN
        RAISE EXCEPTION
            'audit: primary key %(s) not present in the %.% payload — check pk_columns / ignored_columns',
            v_pk_cols, TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = 'undefined_column';
    END IF;

    INSERT INTO audit.logged_actions (
        schema_name, table_name, row_id, row_id_is_json, action,
        old_data, new_data, changed_fields,
        changed_by, bypass_attempted, client_query, changed_at
    ) VALUES (
        TG_TABLE_SCHEMA, TG_TABLE_NAME, v_row_id, v_row_id_is_json, SUBSTRING(TG_OP, 1, 1),
        v_old_data, v_new_data, v_diff,
        NULLIF(current_setting('app.current_user_id', true), ''),
        v_bypass_denied, v_query, clock_timestamp()
    );

    IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION audit.log_change() FROM PUBLIC;

CREATE OR REPLACE FUNCTION audit.track_table(
    target_table    REGCLASS,
    pk_columns      TEXT[]  DEFAULT ARRAY['id']::TEXT[],
    ignored_columns TEXT[]  DEFAULT ARRAY[]::TEXT[],
    capture_query   BOOLEAN DEFAULT false
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_table_name   TEXT;
    v_trigger_iud  TEXT;
    v_trigger_u    TEXT;
    v_bad          TEXT[];
BEGIN
    IF pk_columns IS NULL OR array_length(pk_columns, 1) IS NULL THEN
        RAISE EXCEPTION 'audit.track_table: pk_columns must not be empty';
    END IF;

    SELECT array_agg(c) INTO v_bad
    FROM unnest(pk_columns) c WHERE c = ANY(ignored_columns);
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'audit.track_table: pk_columns and ignored_columns overlap on %', v_bad;
    END IF;

    SELECT array_agg(c) INTO v_bad
    FROM unnest(pk_columns) c
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = target_table
          AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped
    );
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'audit.track_table: column(s) % do not exist on %', v_bad, target_table;
    END IF;

    SELECT relname INTO v_table_name FROM pg_class WHERE oid = target_table;
    v_trigger_iud := 'audit_trigger_' || v_table_name || '_iud';
    v_trigger_u   := 'audit_trigger_' || v_table_name || '_u';

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s;', v_trigger_iud, target_table);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s;', v_trigger_u,   target_table);

    EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION audit.log_change(%L, %L, %L);',
        v_trigger_iud, target_table, pk_columns, ignored_columns, capture_query);

    EXECUTE format(
        'CREATE TRIGGER %I AFTER UPDATE ON %s
         FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
         EXECUTE FUNCTION audit.log_change(%L, %L, %L);',
        v_trigger_u, target_table, pk_columns, ignored_columns, capture_query);
END;
$$;

REVOKE EXECUTE ON FUNCTION audit.track_table(REGCLASS, TEXT[], TEXT[], BOOLEAN) FROM PUBLIC;

-- Detaches the triggers audit.track_table attached, and nothing else: the rows
-- already recorded stay. Removing them is not this function's job, and there is
-- no function that does it -- an audit trail you can erase selectively is not one.
--
-- The trigger names are derived from the resolved relation exactly as
-- track_table derives them, which is the reason this is a function rather than a
-- string built by the caller. A caller spelling out `DROP TRIGGER
-- audit_trigger_<table>_iud` has to reproduce the naming rule, the quoting of a
-- mixed-case relation, and keep both in step with any future change here.
--
-- Idempotent, like track_table: untracking a table that was never tracked is a
-- no-op, so a down migration can run against a database that never had the
-- triggers.
CREATE OR REPLACE FUNCTION audit.untrack_table(target_table REGCLASS)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_table_name  TEXT;
    v_trigger_iud TEXT;
    v_trigger_u   TEXT;
BEGIN
    SELECT relname INTO v_table_name FROM pg_class WHERE oid = target_table;
    v_trigger_iud := 'audit_trigger_' || v_table_name || '_iud';
    v_trigger_u   := 'audit_trigger_' || v_table_name || '_u';

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s;', v_trigger_iud, target_table);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s;', v_trigger_u,   target_table);
END;
$$;

-- Same restriction as track_table, for a stronger reason: whoever can call this
-- can switch off the audit trail for a table and leave no trace of having done so.
REVOKE EXECUTE ON FUNCTION audit.untrack_table(REGCLASS) FROM PUBLIC;

CREATE OR REPLACE FUNCTION audit.create_monthly_partition(p_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET timezone = 'UTC'
AS $$
DECLARE
    v_start     TIMESTAMPTZ := (date_trunc('month', p_date::timestamp))                    AT TIME ZONE 'UTC';
    v_end       TIMESTAMPTZ := (date_trunc('month', p_date::timestamp) + INTERVAL '1 month') AT TIME ZONE 'UTC';
    v_name      TEXT := 'logged_actions_' || to_char(v_start AT TIME ZONE 'UTC', 'YYYY_MM');
    v_conflicts BIGINT := 0;
    v_attached  BOOLEAN;
BEGIN
    IF to_regclass('audit.' || quote_ident(v_name)) IS NOT NULL THEN
        RETURN;
    END IF;

    -- Only an ATTACHED default partition can hold conflicting rows. While it is
    -- detached (the maintenance runbook), creation is unguarded and safe: that is
    -- what lets the runbook reuse this function instead of hand-written DDL.
    SELECT EXISTS (
        SELECT 1
        FROM   pg_inherits i
        JOIN   pg_class c     ON c.oid = i.inhrelid
        JOIN   pg_namespace n ON n.oid = c.relnamespace
        WHERE  i.inhparent = 'audit.logged_actions'::regclass
          AND  n.nspname = 'audit' AND c.relname = 'logged_actions_default'
    ) INTO v_attached;

    IF v_attached THEN
        SELECT count(*) INTO v_conflicts
        FROM   audit.logged_actions_default
        WHERE  changed_at >= v_start AND changed_at < v_end;
    END IF;

    IF v_conflicts > 0 THEN
        RAISE EXCEPTION
            'audit: % row(s) for % already landed in the DEFAULT partition. Creating % now would hold an ACCESS EXCLUSIVE lock on audit.logged_actions for the whole copy. Run the absorption runbook during a maintenance window instead.',
            v_conflicts, to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM'), v_name
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    EXECUTE format(
        'CREATE TABLE audit.%I PARTITION OF audit.logged_actions FOR VALUES FROM (%L) TO (%L);',
        v_name, v_start, v_end);
END;
$$;

REVOKE EXECUTE ON FUNCTION audit.create_monthly_partition(DATE) FROM PUBLIC;

CREATE OR REPLACE FUNCTION audit.anonymize_subject_batch(
    p_schema     TEXT,
    p_table      TEXT,
    p_row_id     TEXT,
    p_actor      TEXT,
    p_keys       TEXT[],
    p_from       TIMESTAMPTZ,
    p_to         TIMESTAMPTZ,
    p_batch_size INT DEFAULT 10000
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_batch BIGINT;
BEGIN
    -- One bounded batch, no transaction control: the caller loops until this
    -- returns 0, and each call is its own transaction. A procedure with an
    -- internal COMMIT cannot be invoked over the extended query protocol
    -- ("invalid transaction termination"), which would force Node callers to
    -- interpolate their parameters. See anonymizeSubject() in the package.
    UPDATE audit.logged_actions t
    SET    changed_by = CASE WHEN t.changed_by = p_actor THEN 'ANONYMIZED' ELSE t.changed_by END,
           old_data   = t.old_data - p_keys,
           new_data   = t.new_data - p_keys
    WHERE (t.event_id, t.changed_at) IN (
        SELECT event_id, changed_at
        FROM   audit.logged_actions
        WHERE  changed_at >= p_from AND changed_at < p_to
          AND  (   (schema_name = p_schema AND table_name = p_table AND row_id = p_row_id)
                OR (p_actor IS NOT NULL AND changed_by = p_actor) )
          AND  (   jsonb_exists_any(old_data, p_keys)
                OR jsonb_exists_any(new_data, p_keys)
                OR (p_actor IS NOT NULL AND changed_by = p_actor) )
        LIMIT p_batch_size
    );

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    RETURN v_batch;
END;
$$;

REVOKE EXECUTE ON FUNCTION audit.anonymize_subject_batch(TEXT, TEXT, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
