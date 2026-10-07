# SkyLedger

Real-time flight-plan coordination for shared drone corridors.

## Run locally

1. Install Node.js 20 or newer and MongoDB.
2. Install dependencies with `npm install`.
3. Set `MONGODB_URI` in `.env` to your MongoDB connection string.
4. Set `SESSION_SECRET` in `.env` to a random secret generated with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.
5. Start the app with `npm start` and open `http://localhost:3000`.

The first startup seeds the Kaduna Northwest demo flights and the empty Zaria Central corridor. Create an account to submit and manage plans or add corridors. Accounts can also save reusable aircraft details, and each plan can include battery, payload, and contingency information. The capacity grid shows open and occupied 30-minute slots by altitude, with historical departure shifts highlighted when enough operator reports exist. For conflicts between account-owned plans, operators can send a schedule change to the other plan owner, who can accept or decline it.

New plans include a date and map waypoints. Spatial conflicts are advisory estimates: routes on the same altitude band are sampled along the planned time window and flagged when estimated positions come within 100 m. This assumes even progress along the waypoint path; it is not an air-traffic service, clearance, or safety guarantee. Legacy demo plans without coordinates keep the original band/time conflict check.

The map uses OpenStreetMap tiles; weather context is fetched from Open-Meteo and includes its source and retrieval time. Operators may import GeoJSON airspace overlays with a source URL and checked date. These overlays are community-supplied and unverified by SkyLedger; confirm restrictions with the relevant authority before flight. Post-flight reports are operator-submitted and feed corridor reliability summaries.

Accounts create an organization with an owner role. Owners and admins can invite dispatchers, pilots, and viewers from the Team control. To send verification codes, password-reset links, invitations, and notifications, set `RESEND_API_KEY` and `EMAIL_FROM` in `.env` or your hosting provider's environment settings. `EMAIL_FROM` must use a domain verified with Resend. Set `APP_URL` to the deployed app's public URL so generated links point to the correct site. Without email configuration, the team dialog displays a local invitation link to share. Configure trusted review addresses with `AIRSPACE_REVIEWER_EMAILS` (comma-separated); new overlays remain private and pending until a configured reviewer approves or rejects them. A reviewer classification records human review of the cited source and is not an NCAA integration or flight clearance.

The service worker caches the app shell and public corridor schedules, not private account endpoints. Offline plan drafts are stored in this browser and synced with an idempotency key when online. Demo reset only restores seeded demo flights and does not delete user plans.

Run the unit tests with `npm test`.