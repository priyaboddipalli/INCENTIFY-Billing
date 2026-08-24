# INCENTIFY Billing

Private desktop billing and finance application for **INCENTIFY Private Limited**.

**Current baseline:** v2.11.0  
**Tagline:** We Grow Together.

## Baseline scope

This repository baseline preserves the existing v2.11 application functionality, including customers, invoices, payments, Razorpay integration, expenses, earnings, P&L, balance sheet, PDF/Excel exports, business settings, notifications and existing navigation/workflows.

## Run locally

```powershell
npm install
npm start
```

## Build Windows portable package

```powershell
npm run pack:win
```

The packaged directory is created under `dist/`.

## Security

Do not commit production databases, Razorpay secrets, device credentials, API keys, Google credentials or customer financial data. Runtime data and secrets must stay outside Git and are excluded by `.gitignore`.

## Central database migration

v2.11 is the local-storage baseline. The planned v2.12 infrastructure migration will replace only the persistence layer with a private central backend so multiple authorized devices operate against one authoritative database. See `docs/CENTRAL_DATABASE_PLAN.md`.
