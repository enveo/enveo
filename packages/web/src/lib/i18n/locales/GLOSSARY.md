# Translator's glossary

Budgeting is a domain with its own vocabulary, and the biggest quality risk in a
translation is not a typo — it is **drift**: the same concept called three different
things on three screens, so the user never realises they are the same thing.

Pick ONE word per row below for your language, write it here next to your locale, and
use it everywhere. If your language already has an established envelope-budgeting
vocabulary (YNAB and friends ship in many languages), prefer it over a literal
translation of the English.

## The terms

| English | What it means | Watch out for |
| --- | --- | --- |
| **envelope** | A named pot of money for one kind of spending ("Groceries"). The unit the whole app is built on. | Not "category" — a category is a *label on a transaction*, and both words exist in the UI. Keep them distinct. |
| **envelope group** | A heading that collects envelopes ("Home & bills"). | Not a "folder". |
| **available** | Money **left in an envelope right now**: allocation + carry-over − spending. The number the user checks before buying something. | Not "balance" (that is an *account*) and not "remaining budget". Pick a word that reads naturally as a noun on a tight tile. |
| **to be budgeted** | Money that has arrived but is not in any envelope yet. Zero-based budgeting means driving this to 0. | It is a *destination*, not a leftover — avoid words meaning "surplus" or "unspent". |
| **allocation** / **allocated** | Money the user put INTO an envelope for a given month. | Distinct from *spent* and from *available*. |
| **carry-over** (`CARRIED OVER`) | What an envelope carried from the previous month — **can be negative**: an overspent envelope starts the next month in the red. | A word implying "savings" or "surplus" is wrong: it must work with a minus sign in front of it. |
| **spending / spent** | Money that has left an envelope. | — |
| **transaction** | One ledger entry: expense, income, or transfer. | The generic word, used everywhere. |
| **refund** | Money coming BACK on an expense (a return, a cashback). Reduces spending in its envelope rather than counting as income. | Not "income" and not "reimbursement of a loan". |
| **transfer** | Movement between two of the user's own accounts. Never touches an envelope. | Not a bank "wire/payment to someone else". |
| **account** | Where money physically sits (a bank account, cash, a card). | The domain account — NOT the user's login account. In sync/auth strings, "account" means the login; keep the two distinguishable if your language allows. |
| **on-budget / off-budget** | Whether an account's balance participates in the budget maths. | — |
| **recurrence** / **recurring payment** | A rule that materialises a transaction on a schedule (rent, a subscription). | "Subscription" is the *user-facing* subset — the app uses both words deliberately. |
| **wealth envelope** | An envelope flagged as savings/investment; it feeds Net worth and is excluded from spending reports. | — |
| **reconcile** | Compare the app's account balance with the bank's and book the difference. | The accounting term, if your language has one. |
| **sync / local mode** | Sync = push/pull with the server. Local mode = the device keeps the data and the server holds nothing. | — |
| **pairing code** | A one-shot code that carries the encryption key to a new device. | Not a "password" and not a "2FA code". |

## Rules

1. **Never translate numbers, money, or dates.** They come from `Intl` at runtime.
   A dictionary entry must never contain a currency symbol or a decimal separator.
2. **Placeholders survive verbatim**: `{n}`, `{name}`, `{amount}`, `{date}`, `{pct}`.
   Reorder them freely inside the sentence; never rename or drop one.
3. **Plurals** are objects keyed by CLDR category. The categories your language needs are
   computed, not guessed: `new Intl.PluralRules("cs").resolvedOptions().pluralCategories`.
   The English source carries both forms joined by `" | "` — that joined string is the KEY,
   never a value.
4. **Words the user must TYPE stay typeable.** `DELETE`, `RESET`, `DISABLE-E2EE` are typed
   into a confirmation box and matched after `.toUpperCase()`. Keep them uppercase, and
   prefer characters that exist on a keyboard the user plausibly has — a word nobody can
   type is a lock-out, not a cosmetic bug.
5. **`**bold**` markers and `→` arrows are markup**, not prose. Keep them where they are.
6. **Leave a translation out rather than guess.** A missing entry renders correct English;
   a confident wrong one does not.
