/** Registration policy — enforced SERVER-SIDE (better-auth before-create hook). */
export type SignupPolicyInput = {
  deployment: "selfhost" | "cloud";
  allowSignups: string;
  hasCredentialedUser: boolean;
};

export function signupsOpen(i: SignupPolicyInput): boolean {
  return i.deployment === "cloud" || i.allowSignups === "1" || !i.hasCredentialedUser;
}
