# Auth Domain Scoping

Domain scoping ensures that adapter credential injection is limited to explicitly declared API domains, preventing credentials from being sent to unintended destinations.

## Problem

`ctx.fetch()` injects auth credentials into outgoing requests. Without domain scoping, an adapter that declares both a legitimate API domain and an unrelated domain would cause user credentials to be sent to both. Domain scoping separates "domains that need auth" from "domains the adapter can reach."

## Design

The adapter manifest splits network access into two domain lists:

```ts
interface AdapterManifest {
  // Domains that receive injected auth credentials
  authenticatedDomains: string[];

  // Domains the adapter can reach WITHOUT credentials (CDNs, webhooks, etc.)
  allowedDomains?: string[];

  // ... rest of manifest
}
```

### Behavior in `ctx.fetch()`

```
ctx.fetch("https://api.stripe.com/...")   → ✅ Auth injected (in authenticatedDomains)
ctx.fetch("https://files.stripe.com/...")  → ✅ Auth injected (in authenticatedDomains)
ctx.fetch("https://cdn.example.com/...")   → ✅ Allowed, NO auth (in allowedDomains)
ctx.fetch("https://evil.com/...")          → ❌ DomainNotAllowedError (not in either list)
```

### How It Works

1. **Domain check**: `ctx.fetch()` checks the target hostname against both `authenticatedDomains` and `allowedDomains`. If the hostname is not in either list, a `DomainNotAllowedError` is thrown.
2. **Auth injection**: `injectAuthHeaders()` is only called when the target hostname matches `authenticatedDomains`. Requests to `allowedDomains` proceed without credentials.
3. **401 retry**: When an authenticated request returns HTTP 401, `ctx.fetch()` forces a credential refresh and retries once. This retry logic is skipped entirely for `allowedDomains`-only requests.
4. **Strategy bypass**: Auth strategies `none` and `client-credentials` skip header injection regardless of domain. For `client-credentials`, the adapter manages its own token exchange via `getCredential()`, which is not domain-gated.

### Wildcard Matching

Domain lists support wildcard subdomains using the `*.` prefix:

- `*.stripe.com` matches `api.stripe.com`, `files.stripe.com`, etc.
- `*.stripe.com` does **not** match the bare domain `stripe.com`

Domain matching is case-insensitive and ignores trailing dots.

### Development Mode

In non-production environments (`NODE_ENV !== "production"`), `localhost` and `127.0.0.1` are always permitted regardless of domain lists.

### Validation Rules

The `defineManifest()` function enforces:

- **`authenticatedDomains` is required.** Adapters with an auth strategy other than `none` must declare at least one authenticated domain.
- **No overlap.** A domain cannot appear in both `authenticatedDomains` and `allowedDomains`. This keeps the intent of each entry explicit.
- **Type safety.** Both fields must be arrays of non-empty strings. Entries are trimmed and validated.

### Edge Cases

- **Multiple authenticated domains**: Adapters that need auth on several domains (e.g., `api.stripe.com` + `files.stripe.com`) list them all in `authenticatedDomains`.
- **Third-party CDNs**: Domains used for asset fetching without auth go in `allowedDomains` only.
- **`client-credentials` strategy**: `getCredential()` works regardless of domain — the adapter manages its own token exchange outside the header injection pipeline.

### Auth Strategies

`injectAuthHeaders()` supports the following strategies:

| Strategy | Header Set | Credential Fields Used |
|---|---|---|
| `bearer` | `Authorization: Bearer <token>` | `token` |
| `api-key-header` | `<headerName>: <apiKey>` (default: `X-Api-Key`) | `apiKey` |
| `basic` | `Authorization: Basic <base64>` | `username`, `password` |
| `cookie` | `Cookie: <cookieName>=<cookieValue>` | `cookieValue` |
| `custom` | `<headerName>: <headerValue>` | `headerValue` |
| `client-credentials` | *(none — adapter manages tokens)* | — |
| `none` | *(none)* | — |

Missing credential fields throw an error with the field name and platform for clear diagnostics.
