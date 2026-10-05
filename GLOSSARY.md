# Enveo

A private, local-first envelope budgeting app. This glossary fixes the words the code, the UI and the docs use for the same things.

## Language

### Budget

**Envelope**:
A pot of budgeted money that spending is drawn from.
_Avoid_: category, bucket, fund

**Category**:
The label saying what a transaction was for, independent of the envelope that paid for it.
_Avoid_: label, tag

**Place**:
The counterparty of a transaction as the budget names it, such as a shop or an employer.
_Avoid_: payee, vendor, shop

**Merchant tag**:
The bank's merchant text for an entry, normalized and kept on its transaction so later imports recognize the same merchant and entry. It is never edited by hand.
_Avoid_: bank tag, label, place

### Import

**Import**:
A batch of bank entries for one account, recognized from screenshots or statement pages. Once ready it does not change; only its review does.
_Avoid_: job, upload, scan

**Review**:
A person's pass over a ready import: choosing which rows to add and correcting their details before they go into the budget.
_Avoid_: draft, edit session

**Review changes**:
What the person changed during a review: row details, which rows are checked, an applied bank-balance suggestion, the bank balance they typed and the choice to reconcile after adding.
_Avoid_: import changes, draft

**Recognized state**:
What a review shows without review changes: the import's rows as recognized, judged against the budget as it is now, so rows already added and newly found duplicates are accounted for.
_Avoid_: initial state, original import, first view

**Reset**:
Discarding all review changes at once, so the review shows the recognized state again. Transactions already added stay in the budget.
_Avoid_: undo, revert, start over

**Already added**:
A row whose transaction this import has already put in the budget, for example before an interrupted Add.
_Avoid_: applied, imported
