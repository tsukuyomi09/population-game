export type GoogleIdentity = {
  googleSub: string;
  email: string;
};

export function verifiedGoogleIdentity(
  profile: unknown,
  providerAccountId: string,
): GoogleIdentity | null {
  if (typeof profile !== "object" || profile === null) return null;

  const googleProfile = profile as Record<string, unknown>;
  if (
    googleProfile.email_verified !== true ||
    typeof googleProfile.sub !== "string" ||
    googleProfile.sub !== providerAccountId ||
    typeof googleProfile.email !== "string" ||
    googleProfile.email.length === 0
  ) {
    return null;
  }

  return {
    googleSub: googleProfile.sub,
    email: googleProfile.email,
  };
}
