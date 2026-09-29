import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { verifiedGoogleIdentity } from "./features/account/google-identity";
import {
  findUserByGoogleSub,
  refreshExistingUserEmail,
} from "./features/account/server/users";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    signIn({ account, profile }) {
      if (account?.provider !== "google") return false;

      return Boolean(verifiedGoogleIdentity(profile, account.providerAccountId));
    },
    async jwt({ token, account, profile }) {
      let user = null;

      if (account?.provider === "google") {
        const googleIdentity = verifiedGoogleIdentity(
          profile,
          account.providerAccountId,
        );

        if (!googleIdentity) return token;

        token.googleSub = googleIdentity.googleSub;
        token.googleEmail = googleIdentity.email;
        user = await refreshExistingUserEmail(
          googleIdentity.googleSub,
          googleIdentity.email,
        );
      } else if (typeof token.googleSub === "string") {
        user = await findUserByGoogleSub(token.googleSub);
      }

      token.worldrawingUserId = user?.id;
      return token;
    },
    session({ session, token }) {
      session.googleSub =
        typeof token.googleSub === "string" ? token.googleSub : undefined;
      session.googleEmail =
        typeof token.googleEmail === "string" ? token.googleEmail : undefined;
      session.worldrawingUserId =
        typeof token.worldrawingUserId === "string"
          ? token.worldrawingUserId
          : undefined;

      return session;
    },
  },
});
