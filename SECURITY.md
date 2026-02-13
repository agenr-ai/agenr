# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AGENR, please report it responsibly.

**Do not** open a public GitHub issue for security vulnerabilities.

### How to Report

Email: **security@agenr.ai**

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if you have one)

### What to Expect

- **Acknowledgment** within 48 hours
- **Assessment** within 7 days
- **Fix timeline** communicated after assessment
- **Credit** in the security advisory (unless you prefer anonymity)

## Scope

The following are **in scope**:
- AGENR server (`src/`)
- Console application (`console/`)
- SDK (`packages/sdk/`)
- OAuth and credential flows
- Adapter execution and sandboxing

The following are **out of scope**:
- Third-party APIs that adapters connect to
- Social engineering attacks
- Denial of service attacks against hosted infrastructure
- Vulnerabilities in dependencies (report those upstream; let us know if they affect AGENR)

## Security Architecture

AGENR takes security seriously:

- **Credential encryption**: All stored credentials use AES-256-GCM envelope encryption with hardware-bound master keys
- **Authentication**: API key authentication with tiered scopes; session cookies for the console (HttpOnly, Secure, SameSite)
- **Rate limiting**: IP-based pre-auth throttling
- **CORS**: Default-deny when origins are not configured
- **Adapter isolation**: Domain allowlisting on outbound requests; execution timeouts
- **Error handling**: Sanitized error responses — no internal details leaked to clients
- **Audit logging**: All credential access events are logged with execution context

## Known Limitations

- Adapters execute in the same process as the server (no VM/container isolation). This is acceptable for admin-generated adapters but should be hardened before accepting community-submitted adapter code at runtime.
- OAuth token refresh is best-effort — concurrent refresh requests are not deduplicated.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅        |
| Older   | ❌        |

We only support the latest release. Update frequently.
