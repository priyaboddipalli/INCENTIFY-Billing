# INCENTIFY Billing v2.12 — Central Database Plan

## Objective

Preserve the existing desktop UI and business functionality while replacing per-device local JSON persistence with one private authoritative data store accessible to any number of authorized client devices.

## Target architecture

Desktop Electron app -> HTTPS API -> Google Apps Script -> private Google Drive datastore.

## Required controls

- Private backend deployment and private datastore ownership.
- Per-device authorization and revocation.
- Server-side locking for concurrent writes.
- Monotonic database revision numbers / optimistic concurrency checks.
- Server timestamps for authoritative write ordering.
- Automated backups before/after critical write windows.
- Audit events containing device ID, action, record ID, revision and result.
- No production database or secrets in Git.
- Razorpay secrets remain encrypted/server-side where possible.

## Migration rule

The existing local database remains the v2.11 rollback source. Production migration is performed once, validated, backed up and imported as revision 1. After cutover, the central datastore is authoritative.

## First production tests

1. Device A creates a customer; Device B sees it.
2. Device A creates an invoice; Device B receives the next unique invoice sequence.
3. Two devices create records concurrently without data loss.
4. Stale revisions are rejected instead of overwriting newer state.
5. Revoked devices cannot read or write production data.
6. Backend outage does not corrupt local or central state.
7. Backup restore reproduces a known revision.
