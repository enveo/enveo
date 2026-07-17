/** Registration policy — enforced SERVER-SIDE (better-auth before-create hook). */
export type SignupPolicyInput = {
  deployment: "selfhost" | "cloud";
  allowSignups: string;
  hasCredentialedUser: boolean;
};

export function signupsOpen(i: SignupPolicyInput): boolean {
  return i.deployment === "cloud" || i.allowSignups === "1" || !i.hasCredentialedUser;
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
