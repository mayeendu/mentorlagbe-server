# MentorLagbe API

Use Node.js 24 and a reachable MongoDB replica set or sharded deployment. Tuition creation uses MongoDB transactions to enforce each tutor's posting limit across simultaneous requests. From `server/`, run `npm ci`, copy `.env.example` to `.env`, and set `MONGODB_URI`. The example URI expects a local single-node replica set named `rs0`. Start MongoDB with `--replSet rs0` and initialize it with `rs.initiate()` in `mongosh`, or use a replica set connection string from your MongoDB provider. Keep credentials in your local `.env` or deployment environment.

`PORT` defaults to `5000`. Set `BETTER_AUTH_URL` to `http://localhost:5000` and `CLIENT_URL` to `http://localhost:3000` for local development. Generate a private `BETTER_AUTH_SECRET` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and put it in `.env`.

Better Auth handles email/password authentication under `/api/auth/`. Public registration accepts Student or Tutor and assigns the free plan. The server owns both persisted fields. Admin access requires a trusted operator to provision the role in MongoDB.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API in watch mode |
| `npm run typecheck` | Check TypeScript |
| `npm test` | Run authorization and tuition tests |
| `npm run build` | Compile the API to `dist/` |
| `npm start` | Run the compiled API |

The API starts listening after MongoDB connects. With the default port, `GET http://localhost:5000/api/health` returns HTTP 200 with a JSON status of `ok`.

For the role test APIs, use your Better Auth session cookie to obtain a five-minute Bearer token from `GET /api/auth/token`. The frontend exports `authenticatedApiFetch` in `client/src/lib/api-client.ts` for these requests. The public keys are available at `GET /api/auth/jwks`, and Better Auth persists its signing keys in MongoDB.

`GET /api/student/test`, `GET /api/tutor/test`, and `GET /api/admin/test` each require the matching current role from MongoDB. Sign-out prevents minting new tokens from that session. Issued tokens expire independently.

Tutor tuition routes are under `/api/tutor/tuitions`. Use `GET` and `POST` on the collection, `GET`, `PATCH`, and `DELETE` on `/:id`, and `PATCH /:id/active` with an `isActive` boolean. Free tutors can keep two posts, including inactive or pending posts. Deleting a post frees a slot.

Set `IMGBB_API_KEY` in the server environment to enable `POST /api/tutor/tuitions/image`. The route accepts raw JPEG, PNG, or WebP files up to 5 MB and returns an `imageUrl` for the tuition record.

Public reads use `GET /api/tuitions` and `GET /api/tuitions/:id`. The list accepts `search`, `subject`, `classLevel`, `mode` (`home` or `online`), `page`, and `limit` (maximum 50). Both routes serve approved, active posts.

Students can submit to `POST /api/tuitions/:id/applications`, list at `GET /api/student/my-applications`, and cancel a pending application with `DELETE /api/student/my-applications/:id`. Tutors list their applicants with `GET /api/tutor/applicants` and decide pending applications with `PATCH /api/tutor/applicants/:id/accept` or `/reject`.

### Payment modes

Set `PAYMENT_MODE=mock` for local development without a Stripe account. Register test accounts in the isolated `mentorlagbe_mock` database. The mock checkout lets those accounts simulate success, failure, or cancellation without collecting money. Use a non-production server environment. Startup rejects mock mode when `NODE_ENV=production`.

Set `PAYMENT_MODE=disabled` to disable checkout. Set `PAYMENT_MODE=stripe` to use Stripe. Outside production, this mode uses the isolated `mentorlagbe_stripe_test` database and requires test keys. In production, it uses `mentorlagbe` and requires live keys and an endpoint-specific signing secret.

### Stripe sandbox verification

Set `STRIPE_SECRET_KEY` to a Stripe test secret key and `STRIPE_WEBHOOK_SECRET` to the signing secret for this webhook endpoint. Keep both values in the server environment. For local development, use `stripe listen --forward-to localhost:5000/api/payments/webhook --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired` and use the signing secret printed by the CLI.

Student Pro costs $10 USD and Tutor Pro costs $15 USD. Each is a one-time Checkout payment. Leave webhook forwarding running through confirmation, or the payment history will stay pending until Stripe delivers the event. Checkout and its return pages use the configured client origin.

The tuition suite uses a database double by default. Set `TUITION_TEST_MONGODB_URI` to a test replica set and run `npm test` to exercise the same cases with MongoDB. The suite creates and drops its own temporary database.
