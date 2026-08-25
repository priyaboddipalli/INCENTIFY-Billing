# INCENTIFY ERP — GitHub Frontend v5.1

Public static frontend converted from the verified INCENTIFY Billing v2.11 Electron UI.

## Public flow
`index.html` → approved-email OTP → `erp.html` → private cloud data. Admins can open `admin.html`.

## Backend
Configured Apps Script deployment:
`https://script.google.com/macros/s/AKfycby1_E9Kk6qpv3LPXZB7j5lF_XLSiXa_Yc8l4dgRKNykXIfkd9VO9LTLSroTnPtnQUoY/exec`

The frontend communicates through a hidden Apps Script **Bridge.html** iframe. This avoids cross-origin fetch/CORS problems while keeping the ERP UI on GitHub Pages. The Apps Script page is only a transport bridge, not the ERP frontend.

## GitHub Pages
1. Push this folder to the public `INCENTIFY-Billing` repository.
2. Repository Settings → Pages → Deploy from branch → `main` / root.
3. Public URL should be `https://priyaboddipalli.github.io/INCENTIFY-Billing/`.

## Preserved ERP modules
Dashboard, New Invoice, Invoices, Bills/Payments, Razorpay Payment Gateway, Customers, History, Finance, Expenses, Earnings, P&L, Balance Sheet, Business Settings, invoice printing/PDF workflow, financial XLSX export, payment receipts.

## Security
Public Git contains no customer database, OTP codes, session tokens, Razorpay secret, Google credentials or Drive files. All protected backend actions require an active server session and role authorization.
