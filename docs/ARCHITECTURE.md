# Architecture

Public GitHub Pages hosts login / ERP / admin UI. A hidden iframe points to Apps Script `?bridge=1`. The bridge uses `google.script.run` and `postMessage`, solving browser CORS without moving the ERP UI into Apps Script. Apps Script owns authentication, sessions, RBAC, audit, Razorpay secrets, Google Sheets mirrors and Google Drive master/backups.
