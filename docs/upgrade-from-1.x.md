# Upgrading from 1.x to 2.0+

One-time migration for installs that predate mandatory accounts. If your
install started on 2.0 or later, this page does not concern you.

2.0 makes accounts mandatory. A 1.x database has no *credentialed* account —
only a password-less stub user (`owner@example.com` on a standard install) that
already owns your budget — so the instance presents as first-run.

**Do not register a new account.** Give the existing stub user a password
instead: it already owns your ledger, so signing in as that user is the whole
upgrade — no SQL, no reattachment, no window in which your devices see a
foreign budget.

**1. Back up — this is your roll-back-to-1.x point.** Take it BEFORE you touch
`.env` and BEFORE you rebuild: the next start runs migrations `0014`/`0015`
against this database (`0014` drops the `sync_ops` primary key), and after that
the dump is no longer a 1.x database.

```bash
docker compose exec -T db pg_dump -U enveo enveo | gzip > pre-2.0-backup.sql.gz
gzip -t pre-2.0-backup.sql.gz     # the archive must be intact; no output = fine
```

**2. Add the session secret and rebuild:** put `BETTER_AUTH_SECRET=…`
(`openssl rand -hex 32`) into `.env`, then `make rebuild` (migrations run on
start).

**3. Give the pre-2.0 owner a password, then sign in as them:**

```bash
docker compose exec db psql -U enveo -d enveo -c 'SELECT id, email FROM users;'   # usually one row: owner@example.com
docker compose exec app sh -c 'cd packages/api && bun run auth:reset-password owner@example.com "YourNewPassword"'
```

The CLI creates the credential account this user never had (that is exactly the
Google-only/no-password case it handles), so registration **closes** and the
login screen switches to sign-in. Sign in with that e-mail and the password you
just set: your budget is already attached to that account, and every device
keeps syncing against it.

## If you already registered a NEW account

Then you have two users, and the new one owns an **empty** budget created
lazily on its first request; the real budget is still on the stub user. Either
sign in as the stub user anyway (step 3 above — the extra account is harmless),
or reattach the budget:

> **Stop the app first.** An account with no budget gets an empty one created
> *lazily, by any request* — including the background pull every signed-in
> device fires once a minute. With the app running, such a request can land in
> the middle of the SQL below and re-create a stray empty budget; the account
> then owns **two**, and the server picks one of them by id — possibly the
> empty one, which hides your real budget.

```bash
docker compose stop app                          # no requests while you work
docker compose exec db psql -U enveo -d enveo    # SQL below
```

```sql
-- 1. Inventory. Write down the ids: the REAL budget is the one with your transaction
--    count, the STRAY is the empty one (0 transactions, named 'Budget') on the new user.
SELECT b.id, b.user_id, u.email, b.name,
       (SELECT count(*) FROM transactions t WHERE t.budget_id = b.id) AS transactions
FROM budgets b JOIN users u ON u.id = b.user_id;

-- 2. Reattach BY EXPLICIT ID — never by user_id, never by email. Deleting a budget
--    cascades to every transaction, envelope and allocation in it, and deleting a USER
--    cascades to their budgets (budgets.user_id → users.id ON DELETE CASCADE), so an
--    id-less DELETE that matches the wrong row destroys the ledger. Nothing here
--    touches `users`: the leftover stub user has no budget and no way to sign in — it
--    costs nothing, so leave it alone.
BEGIN;
DELETE FROM budgets WHERE id = '<stray-empty-budget-id>';
UPDATE budgets SET user_id = '<new-user-id>' WHERE id = '<real-budget-id>';

-- 3. Check INSIDE the transaction, before you commit: exactly ONE row must come back,
--    on '<new-user-id>', with your transaction count on it.
SELECT b.id, b.user_id, b.name,
       (SELECT count(*) FROM transactions t WHERE t.budget_id = b.id) AS transactions
FROM budgets b;

COMMIT;   -- anything unexpected in that check? ROLLBACK; and start over from step 1
```

Then `docker compose start app` and reload the app.

**Expected in the meantime:** until the budget is reattached, devices that
already hold your data report that their local copy **could not be matched to
this account** and stop syncing (while the app is stopped they simply see it as
offline). That is the multi-tenant guard doing its job — it refuses to push one
account's ledger into another account's budget. **Nothing is deleted**: the
local data stays on the device, and sync resumes by itself (within a minute, or
on the next app focus) once the app is back up with the budget reattached. Do
not "remove the local data" on those devices while you are mid-upgrade — on a
device that has not synced in a while, that copy may be the freshest one.
