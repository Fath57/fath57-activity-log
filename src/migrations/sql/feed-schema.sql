CREATE TABLE IF NOT EXISTS public.activity_logs (
    id UUID PRIMARY KEY,
    log_name VARCHAR(100) NOT NULL DEFAULT 'default',
    description TEXT NOT NULL,
    subject_type VARCHAR(150),
    subject_id VARCHAR(100),
    causer_type VARCHAR(150),
    causer_id VARCHAR(100),
    event VARCHAR(50),
    properties JSONB,
    tenant_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_subject 
    ON public.activity_logs (tenant_id, subject_type, subject_id, created_at);

CREATE INDEX IF NOT EXISTS idx_activity_logs_causer 
    ON public.activity_logs (tenant_id, causer_type, causer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_activity_logs_feed 
    ON public.activity_logs (tenant_id, log_name, created_at);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created 
    ON public.activity_logs (created_at);

CREATE TABLE IF NOT EXISTS public.activity_outbox (
    id UUID PRIMARY KEY,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activity_outbox_pending 
    ON public.activity_outbox (created_at);
