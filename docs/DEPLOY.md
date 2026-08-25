# Deployment order

1. Deploy the Apps Script ZIP first and run `setupINCENTIFYV51()`.
2. Update the existing Apps Script Web App deployment.
3. Confirm opening the `/exec` URL returns JSON with version `5.1.0`.
4. Confirm `/exec?bridge=1` loads a blank bridge page without an error.
5. Push the GitHub ZIP contents to the repository root.
6. Enable GitHub Pages from `main` / root.
7. Open the GitHub Pages URL; the login screen must appear first.
8. Sign in with the admin email; create a test customer and invoice.
9. Open a second browser and verify the same cloud data.
