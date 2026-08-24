# Security Rules

1. Repository visibility must remain **Private**.
2. Never commit runtime databases or customer records.
3. Never commit Razorpay Key Secret, webhook secrets, device tokens or Google credentials.
4. Production datastore must be owned by the client's controlled account.
5. Each installation receives a unique device identity and revocable authorization.
6. Transport between app and backend must use HTTPS.
7. Concurrent writes require server-side locking plus revision validation.
8. Maintain auditable backups and recovery procedures.
