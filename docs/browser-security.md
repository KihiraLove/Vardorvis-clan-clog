# Browser resource and framing policy

REVIEW-03 R11 / #102 is enforced by the production Nginx configuration in
`infra/nginx/default.conf`. The same header applies to the SPA, deep links,
assets, health/readiness, API responses, conditional responses and errors, using
`add_header ... always`. Locations inherit these server-level headers; adding a
location-specific `add_header` requires retaining the complete security set.

## Resource inventory

| Directive                 | Allowed sources and reason                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default-src`             | `'none'`: unlisted resource types are denied.                                                                                                                                                  |
| `script-src`              | `'self'`: built entry and lazy staff chunks. No inline scripts, event handlers, eval, third-party scripts or blob scripts.                                                                     |
| `script-src-attr`         | `'none'`: deny inline HTML event handlers.                                                                                                                                                     |
| `style-src`               | `'self'`: built stylesheet, with local sprites. No inline style blocks or imported third-party CSS.                                                                                            |
| `style-src-attr`          | `'none'`: deny parsed style attributes. React sets individual CSSOM properties for log scaling and tooltip placement; production browser tests exercise those updates without `unsafe-inline`. |
| `img-src`                 | `'self' data: blob:`: shipped icons/sprites, generated public branding/favicon, same-origin private PNG proof, local icon and logo upload previews. These schemes are allowed only for images. |
| `font-src`                | `'self'`: shipped RuneScape font; system fonts need no request.                                                                                                                                |
| `connect-src`             | `'self'`: browser API reads/writes/polling. WOM is fetched by the server; no browser WOM API origin is required.                                                                               |
| `object-src`, `frame-src` | `'none'`: no plugin documents or embedded frames.                                                                                                                                              |
| `base-uri`                | `'none'`: no HTML base URL changes.                                                                                                                                                            |
| `form-action`             | `'self'`: no foreign form submissions. Application forms use same-origin HTTP clients.                                                                                                         |
| `frame-ancestors`         | `'none'`: the site may not be embedded, including by its own origin. `X-Frame-Options: DENY` supplies the equivalent legacy policy.                                                            |

Ordinary links to WOM, evidence providers and footer destinations remain normal
top-level navigations. They do not require an origin in the fetch directives.
External evidence/WOM links retain `noopener noreferrer`; the global
`Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` stay in place.
Nginx replaces duplicate upstream values with one canonical instance of each.
Session cookies, authentication, CSRF/origin checks, file validation and access
control are unchanged. CSP permission to display an image grants no API access.

The policy follows the [W3C CSP directive definitions](https://www.w3.org/TR/CSP3/).
Source additions must be justified by a real resource need and tested through the
production proxy; avoid wildcard origins, blanket HTTPS, `unsafe-inline` and
`unsafe-eval`.

## Enforcement and rollout

This release starts in **enforcement**, after local production-image acceptance.
There is no report-only interval required by the current resource inventory and
no reporting endpoint collecting private proof URLs. The full local/release gate
blocks regressions before packaging. `Content-Security-Policy-Report-Only` is not
sent. Intentionally blocked test injections are checked separately from ordinary
flows, which must produce zero CSP violation events and no uncaught page errors.

At deployment, inspect the public HTTPS document, deep links, assets and API/error
headers through the real TLS edge, then exercise ordinary/hardcore and staff flows. The edge must preserve the application's policy and
framing headers. Actual host/TLS verification remains a release acceptance step.
If a future resource change needs staged observation, reproduce it locally first;
any reviewed temporary report-only change must name the resource, affected route,
owner and transition deadline. Return to enforcement after the violation is
resolved and the production-proxy gate passes. Keep framing denial enforced
throughout; do not leave a report-only policy as the final hardening state.

## Automated evidence and limits

`node scripts/check-local.mjs` runs `test:security` inside the disposable checks
container after starting the production image and real PostgreSQL.

A loopback-only test edge forwards Nginx responses and headers unchanged. Native
browser loopback secure-context support lets fixture-backed staff writes use `crypto.randomUUID`
without disabling browser security. This is not a TLS or browser-cookie test.
Embedding uses a separate parent document with no CSP; same-origin child requests
are forwarded to the same production Nginx, preserving its framing headers.

It exercises:

- Actual Nginx HTML/deep-link/assets/font/API headers, 304, API 400/401/404 and
  proxy 413 responses, asserting the exact policy and retained protections.
- Real public API/catalog rendering, decoded local icons/font and log scaling
  with the production JavaScript/CSS; mocked credit responses exercise positioned
  tooltips.
- Ordinary/hardcore mode, same-origin PNG proof, desktop/320px layout, WOM popup
  navigation without opener access, stored animated WebP logos and generated icons.
- Staff chunk loading, local icon decoding/blob preview and same-origin private
  proof rendering using isolated API fixtures for the browser staff identity.
- Blocked injected inline/foreign scripts and event handlers, inline
  styles/attributes, foreign
  images/connections/forms, frames and base changes; no prohibited foreign request
  reaches the network fixture.
- Denied same-origin and foreign embedding. The parent test document has no CSP,
  so denial must come from the actual child response's framing policy.

The real HTTP branding smoke also checks headers on successful authenticated
writes/image reads, CSRF/session failures, invalid images and both API/proxy
upload limits. The HTTP smoke retains secure host-only, HttpOnly, SameSite
session cookies and private/auth no-store responses, including an actual private
PNG upload and authorized/anonymous reads. Browser fixtures verify CSP
compatibility, not real browser authentication. The separate [real-stack suite](browser-acceptance.md)
now covers secure-cookie browser → proxy → API → PostgreSQL workflows across
Chromium, Firefox and WebKit (#103). This CSP suite remains Chromium coverage;
neither suite claims deployed public TLS or physical-device acceptance.

Evidence lives under `.data/local-checks/<run-id>/`: `smoke.log` contains the
security test results; `browser/security/` contains per-test captures and failure
traces. No hosted development run, package publication or deployment is needed.
