# MentorLagbe API

Use Node.js 24 and a reachable MongoDB instance. From `server/`, run `npm ci`, copy `.env.example` to `.env`, and set `MONGODB_URI`. The example URI points to a local MongoDB instance. Keep credentials in your local `.env` or deployment environment.

`PORT` defaults to `5000`. Set `BETTER_AUTH_URL` to `http://localhost:5000` and `CLIENT_URL` to `http://localhost:3000` for local development. Generate a private `BETTER_AUTH_SECRET` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and put it in `.env`.

Better Auth handles email/password authentication under `/api/auth/`. Public registration accepts Student or Tutor and assigns the free plan. The server owns both persisted fields. Admin access requires a trusted operator to provision the role in MongoDB.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API in watch mode |
| `npm run typecheck` | Check TypeScript |
| `npm test` | Run the authorization tests |
| `npm run build` | Compile the API to `dist/` |
| `npm start` | Run the compiled API |

The API starts listening after MongoDB connects. With the default port, `GET http://localhost:5000/api/health` returns HTTP 200 with a JSON status of `ok`.

For the role test APIs, use your Better Auth session cookie to obtain a five-minute Bearer token from `GET /api/auth/token`. The frontend exports `authenticatedApiFetch` in `client/src/lib/api-client.ts` for these requests. The public keys are available at `GET /api/auth/jwks`, and Better Auth persists its signing keys in MongoDB.

`GET /api/student/test`, `GET /api/tutor/test`, and `GET /api/admin/test` each require the matching current role from MongoDB. Sign-out prevents minting new tokens from that session. Issued tokens expire independently.
