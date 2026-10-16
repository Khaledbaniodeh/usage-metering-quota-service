# API reference

The complete public HTTP API of the Usage Metering and Quota Service. The interactive OpenAPI
document generated from the route schemas is served at `GET /docs` (raw JSON at
`GET /docs/json`); this page and the [README](../README.md) describe the same contract.

- Base URL in the Compose stack: `http://127.0.0.1:8080`.
- Every request and response body is JSON. Unknown request fields are rejected, and nothing is
  coerced: `"10"` is not the number `10`.
- Every endpoint except `POST /v1/accounts` and the health and documentation endpoints requires
  the `X-API-Key` header, and acts only on the account that owns the key.

## Accounts and API keys

### Create an account

`POST /v1/accounts` is public. The name must be 1-100 characters on a single line, without control
characters or leading or trailing whitespace; names do not need to be unique. Unknown fields are
rejected.

```bash
curl -s -X POST http://127.0.0.1:8080/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme"}'
```

Response `201 Created` (values shortened):

```json
{
  "id": "<account-id>",
  "name": "Acme",
  "createdAt": "2026-10-13T09:30:15.123Z",
  "updatedAt": "2026-10-13T09:30:15.123Z",
  "plan": {
    "id": "a0000000-0000-4000-8000-000000000001",
    "code": "starter",
    "name": "Starter",
    "scope": "ACCOUNT",
    "monthlyAllowance": 10000,
    "maxUnitsPerRequest": 100
  },
  "apiKey": "umqs_<43 characters>"
}
```

- **The API key is shown only once.** Store it securely: the response is sent with
  `Cache-Control: no-store`, and the service keeps only the SHA-256 digest of the key, so it can
  never show the key again. Lost keys cannot be recovered; key rotation is out of scope.
- **Every new account starts on the predefined Starter plan** (10,000 units per month, at most 100
  per request).
- Keys have the form `umqs_` followed by 43 base64url characters (32 random bytes).

### Authenticate

Protected endpoints require the key in the `X-API-Key` header, exactly once and unmodified. The
example below reads it from an environment variable instead of pasting it into the command:

```bash
export UMQS_API_KEY='<your-api-key>'
curl -s http://127.0.0.1:8080/v1/account -H "X-API-Key: $UMQS_API_KEY"
```

`GET /v1/account` returns the account that owns the key, with its assigned plan (the creation
response without `apiKey`). A missing, repeated, malformed or unknown key always receives the same
response, so callers cannot tell which check failed:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "A valid API key is required" } }
```

### Error responses

Every error uses the shape `{ "error": { "code": "...", "message": "..." } }`. Codes are stable and
defined once in [src/shared/error-catalogue.ts](../src/shared/error-catalogue.ts):

| Code                                                                        | HTTP     | Meaning                                                |
| --------------------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| `VALIDATION_ERROR`, `BAD_REQUEST`                                           | 400      | The request is invalid or could not be parsed          |
| `UNAUTHORIZED`                                                              | 401      | A valid API key is required                            |
| `NOT_FOUND`                                                                 | 404      | The route or resource does not exist                   |
| `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PLAN_READ_ONLY`, `PLAN_SCOPE_MISMATCH` | 409      | The request conflicts with current state               |
| `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`                               | 413, 415 | The body is too large or not JSON                      |
| `BUSY_RETRY`, `SERVICE_UNAVAILABLE`                                         | 503      | Retry later (`BUSY_RETRY`) or the service is not ready |
| `INTERNAL_ERROR`                                                            | 500      | Unexpected failure; no internal details are returned   |

## Plans and users

All endpoints below require `X-API-Key` and act only on the authenticated account. An unknown ID
and an ID that belongs to another account always receive the same response, so callers cannot
discover other accounts' resources.

| Endpoint                      | Purpose                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| `GET /v1/plans`               | Predefined plans, then the account's own custom plans (`?scope=` filters) |
| `POST /v1/plans`              | Create a custom plan owned by the account                                 |
| `PATCH /v1/plans/{planId}`    | Change the name or limits of one of the account's custom plans            |
| `POST /v1/users`              | Register a user; it starts on the predefined Basic plan                   |
| `GET /v1/users`               | The account's users with their plans, oldest first, paginated             |
| `GET /v1/users/{userId}`      | One user of the account with its plan                                     |
| `PUT /v1/users/{userId}/plan` | Switch a user's plan                                                      |
| `PUT /v1/account/plan`        | Switch the account's plan                                                 |

### Plans

Every plan has a scope: `ACCOUNT` plans apply to the account's shared allowance and `USER` plans to
each user's own allowance. The four predefined plans are visible to every account and read-only:

| Code      | Scope   | Monthly allowance | Max units per request |
| --------- | ------- | ----------------- | --------------------- |
| `starter` | ACCOUNT | 10,000            | 100                   |
| `pro`     | ACCOUNT | 100,000           | 1,000                 |
| `basic`   | USER    | 1,000             | 20                    |
| `premium` | USER    | 10,000            | 100                   |

`GET /v1/plans?scope=ACCOUNT` or `?scope=USER` (exact upper case) narrows the list. Custom plans
have `"code": null` and are visible only to the account that created them:

```bash
curl -s -X POST http://127.0.0.1:8080/v1/plans \
  -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Team", "scope": "ACCOUNT", "monthlyAllowance": 50000, "maxUnitsPerRequest": 500}'
```

- Names follow the account-name rules; limits are JSON integers from 1 to 1,000,000,000 (strings
  such as `"500"` are rejected, never converted).
- `PATCH /v1/plans/{planId}` accepts any non-empty subset of `name`, `monthlyAllowance` and
  `maxUnitsPerRequest`; the scope cannot change. A predefined plan returns
  `409 PLAN_READ_ONLY`. Accounts and users already on the plan see the new limits immediately.

### Users

`POST /v1/users` with `{"name": "..."}` registers a user under the authenticated account on the
predefined Basic plan; the plan is assigned in the same statement that creates the user. User names
follow the account-name rules and need not be unique. The response (also used by `GET` and the
plan switch) is:

```json
{
  "id": "<user-id>",
  "name": "Ada",
  "createdAt": "2026-10-13T09:30:15.123Z",
  "updatedAt": "2026-10-13T09:30:15.123Z",
  "plan": {
    "id": "b0000000-0000-4000-8000-000000000001",
    "code": "basic",
    "name": "Basic",
    "scope": "USER",
    "monthlyAllowance": 1000,
    "maxUnitsPerRequest": 20
  }
}
```

`GET /v1/users` returns `{"users": [...], "nextCursor": ...}` in creation order, one page at a
time (see [Pagination](#pagination)). An unknown user and another
account's user both return `404 NOT_FOUND` with the message `User not found`.

### Switching plans

`PUT /v1/account/plan` and `PUT /v1/users/{userId}/plan` take `{"planId": "<uuid>"}` and return the
updated account or user. The plan must be a predefined plan or one of the account's own custom
plans, of the matching scope. Checks apply in this order:

1. Unknown or foreign user: `404 NOT_FOUND`, `User not found`.
2. Unknown or foreign plan: `404 NOT_FOUND`, `Plan not found`.
3. A plan of the other scope (for example `premium` for the account): `409 PLAN_SCOPE_MISMATCH`.

A failed switch changes nothing. Assigning the plan that is already assigned succeeds and returns
the unchanged resource, including its previous `updatedAt`; a real change sets `updatedAt`.

## Consuming units

`POST /v1/consume` (requires `X-API-Key`) asks whether a user of the authenticated account may
consume units now, and counts them if so.

```bash
curl -s -X POST http://127.0.0.1:8080/v1/consume \
  -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "<user-id>", "units": 10, "requestId": "doc-2026-10-13-0001"}'
```

| Field       | Rule                                                                                  |
| ----------- | ------------------------------------------------------------------------------------- |
| `userId`    | UUID of a user of the authenticated account                                           |
| `units`     | JSON integer from 1 to 1,000,000,000 (`"10"`, `10.5`, `0` and negatives are rejected) |
| `requestId` | 1-128 characters from `A-Z a-z 0-9 . _ : -`, chosen by the caller; unique per account |

Unknown fields are rejected. **Every decision is `200 OK`**, whether accepted or not:

```json
{
  "requestId": "doc-2026-10-13-0001",
  "userId": "<user-id>",
  "units": 10,
  "accepted": false,
  "blockingRule": "MONTHLY_ALLOWANCE",
  "blockingLevel": "ACCOUNT",
  "month": "2026-10",
  "processedAt": "2026-10-13T09:30:15.123Z",
  "account": {
    "planId": "a0000000-0000-4000-8000-000000000001",
    "planName": "Starter",
    "monthlyAllowance": 10000,
    "maxUnitsPerRequest": 100,
    "used": 9995,
    "remaining": 5
  },
  "user": {
    "planId": "b0000000-0000-4000-8000-000000000001",
    "planName": "Basic",
    "monthlyAllowance": 1000,
    "maxUnitsPerRequest": 20,
    "used": 120,
    "remaining": 880
  }
}
```

- **Rules.** A request is accepted only when all four checks pass. They are evaluated in this fixed
  order and the first failure is reported as `blockingRule` and `blockingLevel`:
  1. user `MAX_UNITS_PER_REQUEST`
  2. account `MAX_UNITS_PER_REQUEST`
  3. user `MONTHLY_ALLOWANCE`
  4. account `MONTHLY_ALLOWANCE`

  Exactly reaching a limit is allowed. An accepted request adds its units to both the user's and
  the account's usage for the month. A rejection counts nothing. Both `blockingRule` and
  `blockingLevel` are `null` when accepted.

- **Usage values.** `used` is the month's usage after this decision. `remaining` is
  `monthlyAllowance - used`, shown as `0` (never negative) when an allowance was reduced below
  existing usage; further requests at that level are rejected until allowance is available again.
- **Months.** Usage belongs to the UTC calendar month in which the request is processed (`month`,
  `YYYY-MM`). Each month starts at zero; previous months keep their totals.
- **Plan changes.** Each decision records the plan IDs, names and all four limits it used. Plan
  updates and switches apply to requests that start after they succeed, and never change a
  recorded decision. A request in flight uses either the complete old state or the complete new
  state, never a mix.

### Retries and idempotency

The `requestId` makes retries safe. The decision for each `(account, requestId)` is stored once.

- Retrying with the **same `userId` and `units`** returns the original response, byte for byte.
  This holds for accepted and rejected decisions alike, and even after plan changes or the start
  of a new month. Nothing is counted again.
- Reusing a `requestId` with a **different `userId` or `units`** returns `409 IDEMPOTENCY_CONFLICT`
  and changes nothing.
- Request IDs are scoped to the account: another account may use the same value independently.

| Status                     | Meaning                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `200`                      | A decision (accepted or rejected)                                                                            |
| `400 VALIDATION_ERROR`     | Malformed body; nothing recorded                                                                             |
| `401 UNAUTHORIZED`         | Missing or invalid API key                                                                                   |
| `404 NOT_FOUND`            | `User not found`: unknown, or a user of another account (same response); nothing recorded                    |
| `409 IDEMPOTENCY_CONFLICT` | `requestId` already used with a different payload                                                            |
| `503 BUSY_RETRY`           | Too much contention on this account; nothing recorded. Retry the same request after `Retry-After` (1 second) |

After a `500` or a network failure the client cannot know whether a decision was recorded; retrying
with the same `requestId` is always safe and returns the decision if there is one.

**Configuration:** `DB_LOCK_TIMEOUT_MS` (default 2000) bounds how long a request waits for the
account's usage counter before answering `503 BUSY_RETRY`.

## Usage

All usage endpoints require `X-API-Key` and report one UTC calendar month. `month` is `YYYY-MM`
and defaults to the current UTC month; a future month is `400`. Usage counts accepted requests
only, and a month without usage reports `0` (never `404`).

| Endpoint                                    | Returns                                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| `GET /v1/usage?month=`                      | The account's shared usage                                  |
| `GET /v1/users/{userId}/usage?month=`       | One user's usage (unknown and other accounts' users: `404`) |
| `GET /v1/usage/users?month=&limit=&cursor=` | Every user's usage, newest user first, paginated            |

The **current month** includes the limits of the plan assigned now:

```json
{
  "month": "2026-10",
  "used": 120,
  "monthlyAllowance": 1000,
  "maxUnitsPerRequest": 20,
  "remaining": 880
}
```

A **past month** reports `{"month": "2026-09", "used": 340}` only. Today's plan says nothing
about the limits that applied then, so no remaining value is invented; the limits that applied to
each request are recorded on its decision in `GET /v1/history`.

- `remaining = max(0, monthlyAllowance - used)`: when an allowance was reduced below usage it
  shows `0`, and further requests at that level are rejected until allowance is available again.
- Switching plans keeps the month's usage; it never grants a fresh allowance.
- The account's `used` is the sum of its users' accepted usage.

`GET /v1/usage/users` returns `{"month", "currentMonth", "users": [...], "nextCursor"}`. With
`currentMonth: true` each user has `userId`, `name`, `planId`, `planName`, `used`,
`monthlyAllowance`, `maxUnitsPerRequest` and `remaining`; with `currentMonth: false` (a past
month) each user has `userId`, `name` and `used`. Every user is listed, with `used: 0` when it has
no usage in that month.

## Decision history

`GET /v1/history?userId=&month=&limit=&cursor=` (requires `X-API-Key`) lists the account's
consume decisions, newest first:

```json
{
  "userId": null,
  "month": "2026-10",
  "decisions": [
    { "requestId": "doc-1", "accepted": true, "...": "exactly the POST /v1/consume body" }
  ],
  "nextCursor": "eyJ2IjoxLCJrIjoiaGlzdG9yeSIs..."
}
```

- Each decision is **exactly the body `POST /v1/consume` returned**, rebuilt from the stored
  record: plan IDs, names and all four limits as they were at that moment, with `used` and
  `remaining` after that decision. Later plan updates or switches never change it.
- Optional filters: `userId` (a user of the account; an unknown user and another account's user
  both get `404 User not found`) and `month` (`YYYY-MM`, UTC; a future month is `400`). The
  response echoes the filters in effect (`null` when not filtered).

## Pagination

`GET /v1/users`, `GET /v1/usage/users` and `GET /v1/history` return one page at a time:

- `limit`: an integer from 1 to 100 written plainly (no sign, decimal point, exponent, spaces or
  leading zeros); default 20.
- `nextCursor`: pass it as `cursor` to get the next page; it is `null` on the last page. Pages are
  never addressed by offset.
- A continuation request may send only `cursor` (and optionally a different `limit`). The cursor
  carries the traversal's filters (`month`; `userId` for history): a request may repeat them
  exactly but not change them.
- Every unusable cursor gets the same response:
  `400 {"error":{"code":"VALIDATION_ERROR","message":"Invalid cursor"}}`. That includes malformed
  values, a cursor from another endpoint, changed filters, an expired cursor (below) and a cursor
  pointing at a row that is not visible to the caller.

| Endpoint              | Order                 | Notes                                                     |
| --------------------- | --------------------- | --------------------------------------------------------- |
| `GET /v1/users`       | Oldest user first     | Users created during a traversal appear on later pages    |
| `GET /v1/usage/users` | Newest user first     | A current-month traversal expires when the UTC month ends |
| `GET /v1/history`     | Newest decision first | New decisions appear only in a new traversal              |

**Cursor format.** A cursor is opaque to clients but **not secret and not tamper-proof**: it is
unpadded base64url of a small JSON object (version, endpoint, the UUID of the last row returned,
and the bound filters). It is not signed or encrypted. Authorization never comes from the cursor:
every lookup and page query is restricted to the authenticated account in SQL, so a modified
cursor can at most move the caller within its own data, and a cursor naming another account's row
is simply invalid. Cursors never contain API keys, hashes, SQL or internal sequence numbers.

## Health checks and API documentation

| Endpoint            | Meaning                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | `200 {"status":"ok"}` while the process runs; never touches the database                          |
| `GET /health/ready` | `200 {"status":"ready"}` only when PostgreSQL is reachable and every shipped migration is applied |
| `GET /docs`         | Interactive OpenAPI documentation (`GET /docs/json` for the raw document)                         |

When not ready, `/health/ready` returns `503` with the standard error body, for example:

```json
{ "error": { "code": "SERVICE_UNAVAILABLE", "message": "The database is not reachable" } }
```

The Docker image's health check calls `/health/ready`.

## Walkthrough: every business operation

The commands below run against the Compose stack (`docker compose up --build`) and go through the
complete flow once. **Every response value is an example:** IDs, timestamps and cursors differ on
each run, and responses are abbreviated where marked. Placeholders are written as `<...>`.

```bash
API=http://127.0.0.1:8080
```

### 1. Create an account and keep its key

```bash
curl -s -X POST "$API/v1/accounts" -H "Content-Type: application/json" -d '{"name": "Docs Co"}'
```

`201` with the account, its Starter plan and `"apiKey": "umqs_<43 characters>"`. The key is shown
only this once. Keep it in a variable rather than in files or shell history:

```bash
export UMQS_API_KEY='<apiKey from the response>'
curl -s "$API/v1/account" -H "X-API-Key: $UMQS_API_KEY"
```

### 2. Inspect the plans

```bash
curl -s "$API/v1/plans?scope=USER" -H "X-API-Key: $UMQS_API_KEY"
```

```json
{
  "plans": [
    {
      "id": "b0000000-0000-4000-8000-000000000001",
      "code": "basic",
      "name": "Basic",
      "scope": "USER",
      "monthlyAllowance": 1000,
      "maxUnitsPerRequest": 20,
      "createdAt": "<timestamp>",
      "updatedAt": "<timestamp>"
    },
    {
      "id": "b0000000-0000-4000-8000-000000000002",
      "code": "premium",
      "name": "Premium",
      "scope": "USER",
      "monthlyAllowance": 10000,
      "maxUnitsPerRequest": 100,
      "createdAt": "<timestamp>",
      "updatedAt": "<timestamp>"
    }
  ]
}
```

### 3. Register users and switch one to Premium

```bash
curl -s -X POST "$API/v1/users" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" -d '{"name": "Ada"}'
curl -s -X POST "$API/v1/users" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" -d '{"name": "Bob"}'
export ADA='<id of Ada>' BOB='<id of Bob>'

curl -s -X PUT "$API/v1/users/$BOB/plan" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" -d '{"planId": "b0000000-0000-4000-8000-000000000002"}'
curl -s "$API/v1/users/$BOB" -H "X-API-Key: $UMQS_API_KEY"
```

Both users start on Basic (`201`); the switch returns Bob with `"code": "premium"` (`200`).

### 4. List users page by page

```bash
curl -s "$API/v1/users?limit=1" -H "X-API-Key: $UMQS_API_KEY"
```

```json
{
  "users": [{ "id": "<id of Ada>", "name": "Ada", "...": "..." }],
  "nextCursor": "<opaque cursor>"
}
```

```bash
curl -s "$API/v1/users?limit=1&cursor=<nextCursor from the previous page>" \
  -H "X-API-Key: $UMQS_API_KEY"
```

The last page has `"nextCursor": null`.

### 5. An accepted decision, its retry and a conflicting reuse

```bash
curl -s -X POST "$API/v1/consume" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$ADA\", \"units\": 10, \"requestId\": \"docs-ada-1\"}"
```

```json
{
  "requestId": "docs-ada-1",
  "userId": "<id of Ada>",
  "units": 10,
  "accepted": true,
  "blockingRule": null,
  "blockingLevel": null,
  "month": "2026-10",
  "processedAt": "<timestamp>",
  "account": {
    "planId": "a0000000-0000-4000-8000-000000000001",
    "planName": "Starter",
    "monthlyAllowance": 10000,
    "maxUnitsPerRequest": 100,
    "used": 10,
    "remaining": 9990
  },
  "user": {
    "planId": "b0000000-0000-4000-8000-000000000001",
    "planName": "Basic",
    "monthlyAllowance": 1000,
    "maxUnitsPerRequest": 20,
    "used": 10,
    "remaining": 990
  }
}
```

Sending exactly the same request again returns this body byte for byte and counts nothing. The
same `requestId` with different units is refused:

```bash
curl -s -X POST "$API/v1/consume" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$ADA\", \"units\": 11, \"requestId\": \"docs-ada-1\"}"
```

`409 {"error":{"code":"IDEMPOTENCY_CONFLICT","message":"The request ID was already used with a different payload"}}`

### 6. A rejection by the user's limit

```bash
curl -s -X POST "$API/v1/consume" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$ADA\", \"units\": 25, \"requestId\": \"docs-ada-2\"}"
```

`200`, abbreviated: `"accepted": false, "blockingRule": "MAX_UNITS_PER_REQUEST", "blockingLevel": "USER"`,
with Ada's and the account's `used` unchanged at 10. Basic allows 20 units per request.

The same 25 units for Bob (Premium, 100 per request) are accepted: Bob `used: 25`, account
`used: 35`.

```bash
curl -s -X POST "$API/v1/consume" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$BOB\", \"units\": 25, \"requestId\": \"docs-bob-1\"}"
```

### 7. A custom account plan and a rejection by the shared limit

Create an `ACCOUNT` plan that allows exactly the 35 units already used, and assign it:

```bash
curl -s -X POST "$API/v1/plans" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Shared cap", "scope": "ACCOUNT", "monthlyAllowance": 35, "maxUnitsPerRequest": 100}'
export CAP='<id of the new plan>'
curl -s -X PUT "$API/v1/account/plan" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" -d "{\"planId\": \"$CAP\"}"
```

`201` (`"code": null`), then `200` with the account on "Shared cap". Bob's own plan would allow 5
more units, but the account's does not:

```bash
curl -s -X POST "$API/v1/consume" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$BOB\", \"units\": 5, \"requestId\": \"docs-bob-2\"}"
```

`200`, abbreviated: `"accepted": false, "blockingRule": "MONTHLY_ALLOWANCE", "blockingLevel": "ACCOUNT"`,
`"account": {"planName": "Shared cap", "monthlyAllowance": 35, "used": 35, "remaining": 0, ...}`,
`"user": {"planName": "Premium", "used": 25, "remaining": 9975, ...}`.

### 8. Update the plan; the same request now succeeds

```bash
curl -s -X PATCH "$API/v1/plans/$CAP" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" -d '{"monthlyAllowance": 40}'
curl -s -X POST "$API/v1/consume" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$BOB\", \"units\": 5, \"requestId\": \"docs-bob-3\"}"
```

`200` with the updated plan, then an accepted decision: Bob `used: 30`, account `used: 40`,
`remaining: 0`. The client sent the same kind of request as before; only the plan changed.

### 9. Usage

```bash
curl -s "$API/v1/usage" -H "X-API-Key: $UMQS_API_KEY"
curl -s "$API/v1/users/$ADA/usage" -H "X-API-Key: $UMQS_API_KEY"
curl -s "$API/v1/usage/users?limit=1" -H "X-API-Key: $UMQS_API_KEY"
curl -s "$API/v1/usage?month=2026-09" -H "X-API-Key: $UMQS_API_KEY"
```

- Account: `{"month": "2026-10", "used": 40, "monthlyAllowance": 40, "maxUnitsPerRequest": 100, "remaining": 0}`.
- Ada: `{"month": "2026-10", "used": 10, "monthlyAllowance": 1000, "maxUnitsPerRequest": 20, "remaining": 990}`.
- `GET /v1/usage/users` pages through every user, newest first, with the same `cursor` mechanism.
- A past month reports `{"month": "2026-09", "used": 0}` only.

### 10. History

```bash
curl -s "$API/v1/history?userId=$BOB&limit=2" -H "X-API-Key: $UMQS_API_KEY"
curl -s "$API/v1/history?userId=$BOB&limit=2&cursor=<nextCursor>" -H "X-API-Key: $UMQS_API_KEY"
```

Bob's three decisions, newest first, each exactly as `POST /v1/consume` returned it. The
continuation may repeat `userId` but not change it; a changed filter or a modified cursor answers
`400 {"error":{"code":"VALIDATION_ERROR","message":"Invalid cursor"}}`.
