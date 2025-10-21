<!-- File: README.md - Project overview for BrokenLink AI -->
# BrokenLink AI

BrokenLink AI is a full-stack SaaS starter that scans websites for broken links and missing images. The backend uses Node.js with Express to crawl pages, while the frontend uses React + Tailwind CSS to present results, paving the way for Stripe billing and Firebase authentication.

## Project Structure

```
SAAS/
|-- client/        # React + Tailwind frontend (Vite)
|-- server/        # Express API for scanning
|-- package.json   # npm workspaces + shared scripts
|-- README.md
`-- .gitignore
```

## Requirements

- Node.js 18+
- npm 9+

## Environment Variables

Duplicate the `.env.example` files provided in each package and fill in real values when ready:

- `server/.env.example`
  ```bash
  cp server/.env.example server/.env
  ```
- `client/.env.example`
  ```bash
  cp client/.env.example client/.env
  ```

## Install Dependencies

From the project root (`C:\Users\arlin\Downloads\SAAS`):

```bash
npm install
```

The root `package.json` uses npm workspaces so installing once pulls dependencies for both the server and client.

## Run Locally

- **Run both apps:**
  ```bash
  npm run dev
  ```
  This starts the Express API on http://localhost:5000 and the Vite dev server on http://localhost:3000.

- **Run individually:**
  ```bash
  npm run dev:server
  npm run dev:client
  ```

## Backend Options

- `DEBUG_LOGS=true` enables verbose request logging for axios and Puppeteer fallbacks.
- `PUPPETEER_HEADLESS=false` launches a visible Chromium window for troubleshooting (defaults to headless).
- `POST /scan` accepts an optional `cooperation` object:
  ```json
  {
    "url": "https://example.com",
    "cooperation": {
      "whitelistIP": true,
      "siteCredentials": { "user": "owner-user", "pass": "owner-pass" },
      "apiKey": "owner-provided-api-key"
    }
  }
  ```
  Site credentials, API keys, and whitelisting details must come directly from the site owner. Respect robots.txt and do not bypass protections without explicit permission.

## Stripe Billing

The server exposes Stripe subscription endpoints at `/api/payments/checkout-session`, `/api/payments/portal-session`, and `/api/payments/webhook`. Configure the variables listed in `server/.env.example` before running the API.

1. Create a subscription price in Stripe (the sample uses `price_1SKOU11s66D07MjkVp4iPV0h`).
2. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, and your success/cancel/portal URLs in `server/.env`.
3. Start the backend and run `stripe listen --forward-to http://localhost:5000/api/payments/webhook` to capture webhook events. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Launch the frontend and use the "Upgrade to BrokenLink AI Pro" button to initiate Checkout.

Checkout success adds `?checkout=success&session_id=...` to the dashboard URL so the Manage Billing button can open Stripe's customer portal until customer metadata is persisted.

## Deploy Targets

- **Frontend:** Optimized for Vercel via `npm run build --workspace client`.
- **Backend:** Ready for Render using `npm run start --workspace server`.

## Next Steps

- Persist Stripe customer IDs and subscription status once authentication is in place.
- Wire Firebase Authentication and wrap protected routes/components.
- Expand crawling depth, add scheduling, and persist historical scans.

