-- Reusable metric definitions are append-only; historical imports retain snapshots.
CREATE TABLE competition_metric_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO competition_metric_state(singleton) VALUES(true);

CREATE TABLE custom_competition_metrics (
    metric text PRIMARY KEY CHECK (metric ~ '^[a-z][a-z0-9_]{0,79}$'),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND definition->>'metric' = metric),
    actor_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE competition_metric_resolutions (
    token_hash text PRIMARY KEY,
    actor_id text NOT NULL,
    discovery jsonb NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX competition_metric_resolutions_expiry ON competition_metric_resolutions(expires_at,token_hash);
CREATE TABLE competition_metric_audit (
    id uuid PRIMARY KEY,
    actor_id text NOT NULL,
    request_key uuid NOT NULL,
    payload_hash text NOT NULL,
    version bigint NOT NULL,
    definitions jsonb NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(actor_id,request_key)
);
