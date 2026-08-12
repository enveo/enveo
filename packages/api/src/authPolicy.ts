/** Registration policy — enforced SERVER-SIDE (better-auth before-create hook). */
export type SignupPolicyInput = {
  deployment: "selfhost" | "cloud";
  allowSignups: string;
  hasCredentialedUser: boolean;
};

export function signupsOpen(i: SignupPolicyInput): boolean {
  return i.deployment === "cloud" || i.allowSignups === "1" || !i.hasCredentialedUser;
}

/**
 * Cloud operator-key AI spend budget — enablement (backlog §1, decisions 5–6).
 *
 * The per-user monthly allowance protects an OPERATOR key that open registration exposes to
 * untrusted signups. That combination exists only on `DEPLOYMENT=cloud`:
 *  - a normal closed-registration selfhost bypasses ALL spend reads/writes (a handful of
 *    trusted accounts spending the operator's own key);
 *  - `ALLOW_SIGNUPS=1` on selfhost deliberately does NOT enable it (decision 6) — the docs
 *    carry the warning that internet-facing selfhost with open signups must not expose an
 *    operator key (use BYOK or remove OPENAI_API_KEY);
 *  - no operator key ⇒ nothing to protect (byok charges the user's own key, off sends nothing).
 *
 * The cloud branch defers to the authoritative `signupsOpen` policy rather than the deployment
 * label alone: if cloud registration could ever be closed, the limiter follows registration.
 * `hasCredentialedUser: true` is the steady state of a running instance and does not affect the
 * cloud branch of today's policy (cloud is always open).
 */
export type OperatorAiSpendInput = {
  deployment: "selfhost" | "cloud";
  allowSignups: string;
  operatorKeyPresent: boolean;
};

export function operatorAiSpendLimited(i: OperatorAiSpendInput): boolean {
  if (i.deployment !== "cloud") return false;
  if (!i.operatorKeyPresent) return false;
  return signupsOpen({ deployment: i.deployment, allowSignups: i.allowSignups, hasCredentialedUser: true });
}

/** Body of the public GET /api/auth/meta — the login screen asks what to
 *  render. Must leak NOTHING beyond these four fields. `deployment` drives the
 *  client's device-trust default (selfhost → trusted, cloud → untrusted) and is
 *  cached client-side for offline decisions (sign-out, ForeignReplicaScreen). */
export function authMetaBody(i: SignupPolicyInput, hasGoogle: boolean) {
  return {
    signupsOpen: signupsOpen(i),
    firstRun: !i.hasCredentialedUser,
    providers: { google: hasGoogle },
    deployment: i.deployment,
  };
}
