# Backend Setup Guide

Welcome to the Node.js Express backend project. Follow these instructions to set up the repository for local development.

## Prerequisites

Before you begin, ensure you have the following installed on your machine:
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [pnpm](https://pnpm.io/) (used as the package manager in this project)
- [MongoDB](https://www.mongodb.com/try/download/community) (running locally or a MongoDB Atlas cluster URI)
- [Docker](https://www.docker.com/) (optional, for containerized deployment)

## 1. Installation

First, navigate to the project directory and install the dependencies using `pnpm`:

```bash
# Install all dependencies from package.json
pnpm install
```

## 2. Environment Variables

Create a `.env` file in the root directory for default values. This project supports hierarchical environment loading using `dotenv-flow`, similar to Next.js.

### Loading Order
Environment variables are loaded from multiple files with the following priority (later files override earlier ones):
1.  `.env` (Default values)
2.  `.env.local` (Local overrides for all environments - ignored by git)
3.  `.env.[mode]` (Environment specific, e.g., `.env.development`)
4.  `.env.[mode].local` (Local overrides for specific environment - ignored by git)

### Essential Variables
`.env.example` is the annotated template — copy it to `.env` and work through it. The minimum to boot:

```env
# The port your server will run on (defaults to 5000)
PORT=5000

# The URL of your frontend application
FRONTEND_URL=http://localhost:5173

# Your MongoDB connection string. The database name (`saas` here) must not be
# `local`, `admin` or `config` — those are reserved by MongoDB and cannot take
# part in transactions, which Prisma uses for every write.
DATABASE_URL="mongodb://localhost:27017/saas"
```

### Google sign-in (optional)

Email/password sign-in works with no extra setup. To also offer "Continue with
Google", create an OAuth client in the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. **APIs & Services → OAuth consent screen** — pick *External*, fill in the app
   name and support email. While the app is in *Testing*, only the accounts you
   list under **Test users** can sign in; everyone else is rejected before the
   request ever reaches this server.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type *Web application*.
3. Under **Authorised redirect URIs**, add this server's callback — origin +
   `/api/auth/callback/google`:

   ```
   http://localhost:5000/api/auth/callback/google
   ```

   It must match `BETTER_AUTH_URL` exactly, including scheme, port and the
   absence of a trailing slash. Google compares the string literally and fails
   the whole flow with `redirect_uri_mismatch` on any difference. Add one entry
   per deployed origin.
4. Copy the client ID and secret into `.env`:

   ```env
   BETTER_AUTH_URL=http://localhost:5000
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

Leave either variable unset (or at its `replace-me` placeholder) and the provider
is simply not registered: the server logs the redirect URI to configure at boot,
`/api/auth/sign-in/social` answers `404 PROVIDER_NOT_FOUND`, and the frontend's
Google button reports that it is not configured rather than bouncing the user to
a Google error page.

> **Note on existing accounts.** A Google sign-in for an address that already has
> a password account is refused with `account_not_linked`, and the login screen
> tells the user to sign in with their password instead. This is deliberate —
> automatically merging the two would let anyone register an account under
> someone else's address and inherit it the moment that person used Google. The
> two can only be merged safely once the local account's email is verified.

### WhatsApp (Meta Cloud API)

Verification codes on the registration form and on *Edit my registration*, and team invites to a
mobile number, are sent on WhatsApp straight through **Meta's Cloud API** — no BSP. All of it is in
`src/lib/whatsapp.ts`. The Meta-side status (what is approved, what is pending) is in
`../whatsapp-business.md`.

Until it is configured: codes are printed in the server log and shown on the form in a yellow
"Dev mode" note **in development**; **in production** the form cannot send codes (503
`OTP_UNAVAILABLE`). Mobile invites still work — the admin gets the link and shares it.

**1. Settings** — `.env.example` explains each one.

```env
WA_GRAPH_VERSION=v25.0
WA_PHONE_NUMBER_ID=1391824954010292   # test number while trying things; 1367927919739540 is production
WA_WABA_ID=2234487277335089           # test WABA; 1392903549573434 is production
WA_ACCESS_TOKEN=...                   # App → WhatsApp → API Setup (temporary: ~24 h)
WA_DEFAULT_LANG=en
WA_TEMPLATE_OTP=anoopam_otp
WA_TEMPLATE_INVITE=team_invite
```

Restart the server after changing them. The temporary token expires in about a day; the log then
says `WA_ACCESS_TOKEN is expired or invalid`. A permanent token comes from a System User in Business
settings, once 2FA is on for the admin's Facebook account.

**2. Templates** (WhatsApp Manager → Message templates → *Create template*). Templates belong to one
WhatsApp Business Account: to test on the test number, create them in the test WABA too.

*Verification code* — the one the form needs:

| Field | Value |
| --- | --- |
| Name | `anoopam_otp` (`upasana_otp` was deleted on 2026-10-23, and Meta blocks a deleted name for ~30 days) |
| Category | **Authentication** |
| Languages | English (`en`), then *Add language* → Gujarati (`gu`) |
| Code delivery | **Copy code** button |
| Options | Tick *Add security recommendation*; *Expiration* **10 minutes** |

Meta writes the wording of authentication templates itself ("123456 is your verification code…"),
so there is no body to type. The server puts the code in the body and on the button, in the language
the form is shown in. If the Gujarati copy is missing or not approved yet, the code is sent in
English automatically — create the English one first.

If you create them as "English (US)", set `WA_LANG_CODE_EN=en_US`. A mismatch fails with Meta error
132001.

*Team invite* (Utility, English):

| Field | Value |
| --- | --- |
| Name | `team_invite` |
| Category | **Utility** (not Marketing — Utility ~₹0.115, Marketing ~₹0.86) |
| Body | `Hello, {{1}} has invited you to join {{2}} as {{3}}. Tap the button below to sign in and accept. The link works once and expires in 7 days.` |
| Body samples | `Harit Patel`, `Dashabdi Mahotsav`, `Mandal sanchalak for Surat` |
| Button | *Visit website* → **Dynamic** URL `https://<your-frontend-domain>/invite/{{1}}`, text `Accept invite`, sample `abc123` |

The button URL must be the real public domain (Meta refuses `localhost`), and a domain change means
re-approval. Meta also refuses a body that starts or ends with a placeholder.

*Registration confirmation* (Utility, **English and Gujarati**) — sent to the contact the moment a
registration is saved, in the language the form was shown in:

| Field | Value |
| --- | --- |
| Name | `registration_confirmation` (`WA_TEMPLATE_REGISTRATION`) |
| Category | **Utility** |
| Body (en) | `Jay Shree Swaminarayan {{1}}, your registration for the Dashabdi Mahotsav 2027 at Upasana Dham has been received.`<br><br>`Registration code: {{2}}`<br>`People: {{3}}`<br>`Stay: {{4}}`<br><br>`Please keep this code and show it at the registration desk when you arrive. To change any details, open the registration link again and choose "Change my registration".`<br>`– Anoopam Mission` |
| Body (gu) | `જય શ્રી સ્વામિનારાયણ {{1}}, ઉપાસના ધામ ખાતે દશાબ્દી મહોત્સવ 2027 માટે આપની નોંધણી મળી ગઈ છે.`<br><br>`નોંધણી કોડ: {{2}}`<br>`વ્યક્તિઓ: {{3}}`<br>`રોકાણ: {{4}}`<br><br>`કૃપા કરીને આ કોડ સાચવી રાખો અને પહોંચો ત્યારે નોંધણી ડેસ્ક પર બતાવો. વિગતોમાં ફેરફાર કરવા માટે, નોંધણીની લિંક ફરી ખોલી "મારી નોંધણીમાં ફેરફાર કરો" પસંદ કરો.`<br>`– અનુપમ મિશન` |
| Samples | `Harit`, `DM-F-0031`, `4`, `30 Jan, morning – 1 Feb, evening` (gu: `30 જાન્યુ, સવાર – 1 ફેબ્રુ, સાંજ`) |

The four values must stay in that order — `confirmationValues` in `src/lib/registration-confirmation.ts`
fills them. Every local registration against a configured `.env` sends one, and it is paid.

**The PDF link in `{{4}}`** (2026-10-27). After the stay, `{{4}}` carries
`. Everyone's details: <link>` (gu: `. બધાની વિગતો: <link>`) — the registration as a PDF
(`src/lib/registration-pdf.ts`: every person's number, name, gender and age, relation, arrival,
departure and bed, then travel). No template change was needed: a link is just text in the value,
and WhatsApp makes it tappable. The link is `<BETTER_AUTH_URL>/api/registrations/pdf/<id>-<signature>.pdf`,
signed with `BETTER_AUTH_SECRET`, so it opens that registration only, needs no sign-in, never
expires, and is rendered on every open — after an edit the same link shows the new details. Without
both of those settings the value is the stay alone. **Changing `BETTER_AUTH_SECRET` breaks every link
already sent.** The PDF is English in both languages: Helvetica has no Gujarati, and names are
English letters only anyway.

*Room details* (`room_details`) belongs to the paused per-person allotment; what the stay message
says is still to be decided, so do not create it yet.

**3. Try it** without the form:

```bash
pnpm wa:test +91XXXXXXXXXX            # Meta's hello_world — proves token, number id and recipient
pnpm wa:test +91XXXXXXXXXX otp gu     # the OTP template, with a made-up code
```

The test number only delivers to the recipients added in App → WhatsApp → API Setup. Every send from
the production number is a paid message.

**4. Switch registration OTP back on** — once a code arrives from the production number: set
`MOBILE_OTP_REQUIRED = true` in **both** `src/lib/otp.ts` and
`upasana-fe/src/features/registrations/form/schema.ts`. *Edit my registration* always uses a code
and needs no switch.

**If a send fails**, the log line starts `[OTP] WhatsApp code to … failed:` or
`[WhatsApp] Admin invite to … failed:` and carries Meta's error code: 190 expired token, 132001 no
template in that language, 132000 wrong number of values, 131030 recipient not on the test number's
list, 130429 rate limit (retried automatically).

## 3. Database Setup (Prisma)

This project uses [Prisma ORM](https://www.prisma.io/) to interact with the MongoDB database. To set up Prisma for local development:

### Generate Prisma Client
Generate the Prisma Client so you get correct TypeScript type definitions based on your `schema.prisma`. 
*Note: Run this command every time you pull changes or modify `schema.prisma`.*

```bash
npx prisma generate
```

### Push Schema to Database
Since this project uses MongoDB, Prisma does not use standard SQL migrations. To ensure your database collections and indices match your schema, simply push the schema:

```bash
npx prisma db push
```

### Create the partial indexes

**Run this after every `prisma db push`.** Push reconciles indexes against
`schema.prisma` and drops any it does not recognise — including the partial
unique index on `Registration.contactMobile`, which Prisma cannot express.
Without it, the database no longer enforces one registration per contact
number. `pnpm db:push` runs the push and this script together.

```bash
npx ts-node scripts/ensure-partial-indexes.ts
```

### Backfill new fields onto existing documents

**Also run this after a push that added a required field.** MongoDB stores no
schema, so adding `excluded Boolean @default(false)` leaves existing documents
without the key. Prisma hides that on reads — a `select` returns `false` — but
not on filters: `where: { excluded: false }` does not match a document that
lacks the field, so the rows read back fine one at a time and vanish from every
filtered query.

```bash
npx ts-node scripts/backfill-defaults.ts
```

Safe to re-run; it only touches documents still missing the field.

## 4. Running the Application

Now you're ready to start the server!

### Development Mode
To start the server with hot-reloading (using `nodemon`):

```bash
pnpm run dev
```
You should see a console message indicating the server is running on `http://localhost:5000` (or your configured `PORT`), followed by a successful database connection log.

### The Background Worker

Queued jobs run in a **separate process**, not inside the API. Start it alongside
the server:

```bash
pnpm run worker      # the worker alone
pnpm run dev:all     # API and worker together
```

An API running without a worker serves every screen correctly and silently never
does the work behind them — jobs pile up `pending` with no error anywhere. If
your product has no background work yet, you can skip it; add it back the moment
it does.

### Production Build
To compile the TypeScript code to JavaScript into a `dist/` directory:

```bash
pnpm run build
```

To start the compiled production build:

```bash
pnpm run start         # the API
pnpm run worker:start  # the worker, as its own service
```

## 5. Docker Setup (Recommended for Deployment)

You can also run the entire application in a containerized environment using Docker.

### Building the Image
To build the Docker image locally:

```bash
docker build -t upasana-be .
```

### Running with Docker Compose
The easiest way to start the application is using Docker Compose, which handles environment variables and container orchestration:

```bash
# Build and start the container in detached mode
docker compose up --build -d
```

The application will be accessible at `http://localhost:5000` (or your mapped port).

### Useful Docker Commands
- **Stop containers:** `docker compose down`
- **View logs:** `docker compose logs -f`
- **Restart app:** `docker compose restart app`
- **Worker logs only:** `docker compose logs -f worker`
