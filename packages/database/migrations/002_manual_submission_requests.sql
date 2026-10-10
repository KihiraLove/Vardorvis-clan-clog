-- A committed creation receipt survives lost responses and later review changes.
CREATE TABLE manual_submission_requests (
    actor_id text NOT NULL,
    request_key uuid NOT NULL,
    payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    submission_id uuid NOT NULL REFERENCES submissions(id),
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (actor_id, request_key)
);
