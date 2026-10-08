# HAM Plugin Contract

Galaxy Brain can use a Harmonic Addressable Memory (HAM) backend, but the HAM
implementation is intentionally not vendored in this public repo.

Run any compatible HAM service separately and point the authenticated Galaxy
Brain search BFF at it:

```bash
HAM_API_INTERNAL=http://ham:8042
```

For local development outside Docker, `HAM_API_INTERNAL=http://localhost:8042`
is fine.


## Nostr identity contract

Humans sign in to Galaxy Brain with NIP-07 or NIP-46 and use the same Nostr
public key as their HAM and Hyades identity. Galaxy Brain records the key that
proved each session; a password or passkey recovery session is deliberately not
equivalent to a Nostr-authenticated owner session.

Agents use distinct, independently revocable Nostr keys. If
`HAM_NOSTR_SECRET_KEY` is configured, `ham identity show` displays the
public identity. Otherwise `ham identity generate` creates an agent key. Keep
the `nsec` in the agent's local secret store and register only its 64-character
hexadecimal public key. The current command and NIP-98 setup contract lives in
[HAM's agent guide](https://ham.flobots.xyz/llms.txt).
Galaxy Brain's exact registration and request contract is also summarized in
[`llms.txt`](llms.txt).

Identity is intentionally separate from authorization:

- HAM projects are organizational labels, not permission roles.
- HAM-local memory scope ceilings constrain HAM memory access.
- Hyades capabilities, approvals, validity windows, and revocation authorize
  workflow execution.
- GitHub credentials and repository policy authorize GitHub operations.

Galaxy Brain's server-only bearer credentials remain bounded transport and
bootstrap mechanisms during migration. They are not user identity and must
never be exposed to the browser.

## Search Endpoints Used by Galaxy Brain

The frontend treats HAM as an optional plugin. Browser search calls go only to
`/api/ham/search`. The Next.js route authenticates the current user, validates
a closed request contract, forwards the request to one of three allowlisted
HAM retrieval endpoints, and binds the HAM tenant with `X-GB-User-ID`. Browser
input cannot select an upstream path, scope, or identity header. If the service
is unreachable, existing local browser storage and lexical search remain
available.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/search` | `POST` | Scoped semantic, spectral, and lexical retrieval. |
| `/retrieve/multihop/scoped` | `POST` | Scoped multi-hop retrieval. |
| `/retrieve/temporal/scoped` | `POST` | Scoped valid-time, known-time, or event-time retrieval. |

The BFF request selects an operation, not an upstream path:

```json
{
  "query": "Which deployment was live on August 20?",
  "mode": "temporal",
  "topK": 10,
  "asOf": "2026-08-20T12:00:00Z",
  "temporalMode": "valid_at"
}
```

## Example Retrieval Result

Retrieval endpoints should return an array of result objects:

```json
[
  {
    "id": 123,
    "content": "Matched content",
    "score": 0.91,
    "timestamp": "2026-01-01T00:00:00Z",
    "metadata": {
      "type": "document",
      "title": "Document title"
    }
  }
]
```

The BFF intentionally exposes only `title` and `type` from arbitrary HAM
metadata. Write, lifecycle, administration, and RAG-chat operations are not
part of this route and require separately reviewed contracts.
