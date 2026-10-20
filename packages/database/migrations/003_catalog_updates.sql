-- Release content is data. Reviewed decisions and identities survive subsequent releases.
CREATE TABLE catalog_update_batches (
    id text PRIMARY KEY,
    sequence integer NOT NULL UNIQUE,
    hash text NOT NULL UNIQUE,
    manifest jsonb NOT NULL,
    summary jsonb NOT NULL,
    review_required boolean NOT NULL,
    installed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_update_bindings (
    kind text NOT NULL CHECK (kind IN ('item','page')),
    source_key text NOT NULL,
    local_id text NOT NULL,
    PRIMARY KEY(kind,source_key),
    UNIQUE(kind,local_id)
);
CREATE TABLE catalog_update_images (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 2097152),
    width integer NOT NULL CHECK (width BETWEEN 1 AND 512),
    height integer NOT NULL CHECK (height BETWEEN 1 AND 512)
);
CREATE TABLE catalog_update_decisions (
    proposal_hash text PRIMARY KEY,
    actor_id text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('applied','kept')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_update_prompts (
    actor_id text PRIMARY KEY,
    revision text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_update_receipts (
    actor_id text NOT NULL,
    request_key uuid NOT NULL,
    payload_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(actor_id,request_key)
);
CREATE TABLE catalog_update_audit (
    id uuid PRIMARY KEY,
    actor_id text NOT NULL,
    revision text NOT NULL,
    changes jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
