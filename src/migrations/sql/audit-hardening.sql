-- ============================================================================
-- AUDIT HARDENING SCRIPT (DBA execution only)
-- ============================================================================

-- Schema ownership FIRST.
-- Without this, the REVOKE below strips USAGE from audit_admin too (it is not the
-- schema owner), and every SECURITY DEFINER function -- including log_change() --
-- loses access to its own schema. Symptom: "permission denied for schema audit"
-- on the first audited write after hardening.
ALTER SCHEMA   audit                                                   OWNER TO audit_admin;

-- Ownership transfers
ALTER TABLE    audit.logged_actions                                    OWNER TO audit_admin;
ALTER TABLE    audit.logged_actions_default                            OWNER TO audit_admin;
ALTER FUNCTION audit.log_change()                                      OWNER TO audit_admin;
ALTER FUNCTION audit.track_table(REGCLASS, TEXT[], TEXT[], BOOLEAN)    OWNER TO audit_admin;
ALTER FUNCTION audit.create_monthly_partition(DATE)                    OWNER TO audit_admin;
ALTER FUNCTION audit.anonymize_subject_batch(TEXT, TEXT, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INT)
                                                                       OWNER TO audit_admin;

-- Application role privileges (SELECT only)
REVOKE ALL   ON SCHEMA audit           FROM PUBLIC;
GRANT  USAGE ON SCHEMA audit           TO   audit_admin;
GRANT  USAGE ON SCHEMA audit           TO   app_user;
REVOKE ALL   ON audit.logged_actions   FROM PUBLIC, app_user;
GRANT  SELECT ON audit.logged_actions  TO   app_user;

-- Secure existing child partitions
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT c.oid::regclass AS part
        FROM   pg_inherits i
        JOIN   pg_class c ON c.oid = i.inhrelid
        WHERE  i.inhparent = 'audit.logged_actions'::regclass
    LOOP
        EXECUTE format('ALTER TABLE %s OWNER TO audit_admin;', r.part);
        EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, app_user;', r.part);
    END LOOP;
END $$;
