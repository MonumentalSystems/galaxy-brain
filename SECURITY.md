# Security policy

Galaxy Brain is pre-release software intended for a small, invite-only trusted group. Each invited person receives a separate personal tenant. Do not expose the internal PostgreSQL, ELN API, or MarkItDown ports to the public internet.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for the canonical repository. Do not open a public issue containing credentials, exploit details, private documents, or deployment addresses.

Include the affected commit, deployment shape, reproduction steps, and impact where possible. Maintainers will acknowledge the report and coordinate disclosure through the private advisory.

## Deployment checklist

- Use unique random values for the database password, registration invite, and both internal proxy tokens.
- Share personal workspace invitation links directly with the intended recipient. Revoke unused links from **Sign-in security** and never place them in logs, tickets, or public chat.
- Terminate TLS at the deployment ingress and expose only the web service.
- Leave filesystem datasources disabled unless explicit container paths are required.
- Rotate any credential that may have appeared in logs, build arguments, screenshots, or repository history.
- Keep `HAM_ADMIN_API_BEARER_TOKEN` server-only and separate from search/task credentials. Enable the owner administration page only behind TLS and a private HAM service route; verify its recent-authentication gate before issuing credentials.
- Keep dependency alerts, secret scanning, push protection, and CodeQL enabled.

Only the latest commit on the default branch is supported during alpha development.
