-- Password staff accounts replaced Discord OAuth. Only unused, short-lived
-- OAuth handshake tokens are removed; staff accounts/sessions/audits remain.
-- No CASCADE: an unexpected dependency must abort this migration atomically.
DROP TABLE oauth_states;
