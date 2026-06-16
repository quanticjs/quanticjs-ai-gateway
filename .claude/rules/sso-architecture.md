---
globs: "src/app.module.ts, src/**/*-client*.ts, src/**/auth/**/*.ts, src/**/files/**/*.ts, keycloak/**/*.json, docker-compose*.yml"
---

# Platform SSO & Service Identity Architecture

How the platform's apps (multiple BFF web apps, bearer-only APIs, and a shell portal) share identity through a single Keycloak realm. This rule covers realm topology, per-app login, service-to-service communication patterns, and the shell-app SSO design. App-level auth usage (guards, permissions, execution context) is in `auth-patterns.md`.

## One Realm, One SSO Session

All apps live in the **single `your-realm` realm**. SSO is a property of the realm session cookie on the Keycloak domain — not something apps implement. Never split apps into separate realms (it breaks SSO and turns every service call into cross-realm federation), and never share session cookies between apps (each BFF keeps its own `__Host-` cookie; the *Keycloak* session is the only shared state).

**All apps must use the same public Keycloak URL as issuer** (`auth.<domain>` in production). A mismatched issuer URL (e.g., one app pointing at an internal hostname) silently breaks SSO and token validation.

## Client Topology

One Keycloak client per app, by role:

| Client | Type | Used by |
|---|---|---|
| `your-app-backend` | Confidential + service account | your-app BFF login + S2S caller |
| `<workflow-engine>` | Confidential + service account | Workflow-engine BFF login + callbacks |
| `<resource-api>` | **Bearer-only** | Pure resource server — never issues tokens |
| `shell` | Confidential | Shell app BFF login |
| `<service-api>` | Confidential / bearer-only | When it exposes HTTP under v7 audience validation |

Rules:

- **Each app with a UI gets its own confidential client + BFF** (`@quanticjs/auth-web-bff`), its own session cookie name (default `__Host-sid`; e.g. `__Host-qf-sid`, `__Host-shell-sid` via `session.cookieName` — keep the `__Host-` prefix), and its own `KEYCLOAK_AUDIENCE`. Per-app clients give per-app audience and session policy; SSO still works because the realm session is shared.
- **Pure APIs are bearer-only clients** — they validate tokens, never mint them.
- **No shared "frontend" public client across apps.** A token minted for one shared login client works against every API that trusts it — that defeats audience isolation. (A legacy shared public client should be removed for exactly this reason.)
- **Permissions are client roles** on each app's client, assigned via groups (see `auth-patterns.md`). The shell uses these same roles to decide which app tiles a user sees. The IAM audit surface (`@quanticjs/iam-audit`, `/iam/*`, admin-only) reports **effective** client roles — group-derived and composite included (v7.0.3+; earlier versions counted only direct assignments and showed `permissionCount: 0` under group-based conventions).

## Token & Audience Rules (v7)

- Every quanticjs service validates `aud` (`KEYCLOAK_AUDIENCE`, mandatory in production — boot fails without it).
- A token's `aud` must name exactly the services it will be **directly** presented to. Keycloak adds clients to `aud` automatically when the token carries their `resource_access` roles; add explicit *Audience protocol mappers* only for targets not covered by that (e.g., a service-account token calling a service whose roles it doesn't hold). Note: the framework's audience-rejection error message unconditionally tells you to add an Audience mapper — it over-prescribes; a mapper is needed only when the audience isn't otherwise present in the token.
- **Breaking in v7:** cross-client tokens that worked by accident in v6 are now rejected — a service-to-service call returning 401 usually means the caller requested its token without the target service's audience. Fix the token request (client-credentials with the target audience, or subject-token exchange), not the validator.
- The `organization_id` claim (tenant identity) requires a *User Attribute protocol mapper* on each token-issuing client — see `auth-patterns.md`.

## Service-to-Service Communication — Decision Table

Three patterns, each for its proper job. Do not standardize on one.

| Situation | Pattern | Example |
|---|---|---|
| Sync call **on behalf of a user** (downstream enforces user permissions) | **Subject-token exchange**: exchange the incoming user JWT for a token with `audience: <target>`; cache per `sub` | `FileTokenExchangeService` (example consumer app) |
| Sync call as **the system** (no user semantics) | **Client credentials** service token; user attribution travels in the payload for audit | `WorkflowClientService.startProcess()` (example consumer app); `QuanticFlowClient` auth is a service-account token via axios interceptor (`KeycloakTokenService`) |
| **Async** (Kafka) | **Envelope identity** (`userId`, `organizationId` — roles are deliberately NOT carried; the consumer reconstructs an internal-caller context via `runAsService()` with empty roles, which is why authorization must be enforced producer-side before publishing). Topic ACLs restrict who can produce | `quantic.commands` topic (QuanticFlow/consumer contract — framework events use `quantic.events.<aggregate>`) |

Subject-token exchange is a consumer-app pattern today; `@quanticjs` ships no exchange helper.

- **Never forward a raw user JWT to another service** ("JWT forwarding"). It requires broad multi-service audiences and lets any receiving service replay the token laterally. Exchange instead — narrow audience per hop.
- **Never use impersonation exchange** (`requested_subject`) when the user's token is in hand — it requires the realm-management `impersonation` role and can mint tokens for *any* user. Reserve it for genuinely offline act-as-user flows, or model those as system operations.
- **Never put JWTs in Kafka messages** — they expire before retries/replays and persist in the log as replayable credentials.
- Keycloak ≤25 token exchange is the **legacy preview** (`KC_FEATURES: token-exchange`); standard token exchange is GA from Keycloak 26.2. Plan upgrades accordingly — the subject-token pattern maps cleanly onto the standard API; impersonation does not.

## Shell App (portal) (Portal SSO)

The shell is just another BFF app on its own `shell` client. Sign-in flow:

1. User logs into the shell → Keycloak sets the realm SSO cookie on the auth domain.
2. User clicks an app tile → browser navigates to the app → its BFF has no session → redirects to Keycloak → Keycloak sees the realm SSO cookie → **issues a code with no login prompt** → app BFF creates its own session.

No app changes are needed for sign-in. Requirements for the shell itself:

- **Tiles are role-driven**: show an app's tile only if the user holds any client role for that app's client. No separate "app access" registry.
- **Cross-app data on tiles** (task counts, notifications): the shell backend uses subject-token exchange per target service — never a broad-audience shell token.
- **Optional polish**: apps may attempt `prompt=none` silent auth on first load to hide the redirect hop.

### Single Logout (SLO) — Mandatory Before Shipping the Shell

RP-initiated logout (`end_session_endpoint`) ends the **Keycloak** session but leaves every app's **BFF session in Redis alive** until expiry — "logged out of Masaar" must not leave users logged into the apps. Therefore:

- Every BFF must implement **OIDC Back-Channel Logout**: store Keycloak's `sid` claim with the session at login; expose a backchannel endpoint that validates the logout token signature and destroys the matching Redis session. This is a `@quanticjs/auth-web-bff` framework feature — do not hand-roll per app. (The `sid` reverse index is rewritten on every token refresh too, not just at login.)
- **Keycloak client attributes required per app**: `backchannel.logout.url` pointing at the app's backchannel endpoint, and `backchannel.logout.session.required: "true"`. Without the latter, Keycloak sends sub-only logout tokens (no `sid`) and the handler deliberately no-ops — SLO silently does nothing.
- **Backchannel responses**: 400 for invalid logout tokens; 200 for unknown/already-gone sessions (idempotent). No CSRF — the call is server-to-server and the signed logout token is the authentication.
- Shell logout = RP-initiated logout against Keycloak; Keycloak then back-channels every app.
- **Session lifetime alignment**: each BFF session TTL must be ≤ the realm's `ssoSessionIdleTimeout`, so an app session never outlives the SSO session. The default BFF session TTL is **7 days** — set `session.ttlSeconds` explicitly to satisfy this rule.
- Auth cookies are `secure` only when `NODE_ENV === 'production'` — local HTTP dev works, but production deployments must set `NODE_ENV` correctly or the `__Host-` prefix breaks.

## NEVER

- **NEVER** create multiple realms for platform apps — one realm is the SSO boundary
- **NEVER** share a login client between apps — one confidential client per app, each with its own audience
- **NEVER** share or widen session cookies across apps/subdomains — `__Host-` per-app cookies; SSO comes from the Keycloak session
- **NEVER** forward a user's JWT to another service — use subject-token exchange with the target's audience
- **NEVER** use `requested_subject` impersonation exchange when the caller's token is available
- **NEVER** put JWTs in Kafka messages — identity rides in the envelope, enforced producer-side
- **NEVER** point apps at different Keycloak issuer URLs for the same realm
- **NEVER** ship a portal/shell logout without back-channel logout in every member app's BFF
- **NEVER** grant a service account `impersonation` or other realm-management roles it does not demonstrably need
