import Image from "next/image";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { AVATARS } from "../../features/account/avatars";
import { createAccount } from "../../features/account/server/create-account";
import { USERNAME_MAX_LENGTH } from "../../features/account/username";

const ERROR_MESSAGES: Record<string, string> = {
  "invalid-username": `Choose a username between 1 and ${USERNAME_MAX_LENGTH} characters.`,
  "invalid-avatar": "Choose an avatar.",
  "username-taken": "That username is already taken.",
  "account-creation-failed": "Account creation failed. Please try again.",
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.googleSub || !session.googleEmail) redirect("/");
  if (session.worldrawingUserId) redirect("/profile");

  const { error } = await searchParams;

  return (
    <main className="h-screen overflow-y-auto bg-slate-950 px-6 py-12 text-white">
      <form
        action={createAccount}
        className="mx-auto max-w-2xl rounded-xl border border-slate-800 bg-slate-900 p-6"
      >
        <h1 className="text-3xl font-bold">Create your account</h1>
        <p className="mt-2 text-slate-300">
          Choose your permanent username and an avatar.
        </p>

        {error && ERROR_MESSAGES[error] ? (
          <p className="mt-4 rounded-md bg-red-950 px-4 py-3 text-red-200">
            {ERROR_MESSAGES[error]}
          </p>
        ) : null}

        <label className="mt-6 block font-semibold" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          name="username"
          required
          maxLength={USERNAME_MAX_LENGTH}
          autoComplete="username"
          className="mt-2 w-full rounded-md border border-slate-600 bg-slate-950 px-4 py-3"
        />

        <fieldset className="mt-6">
          <legend className="font-semibold">Avatar</legend>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {AVATARS.map((avatar, index) => (
              <label
                key={avatar.id}
                className="cursor-pointer rounded-lg border border-slate-700 p-3 text-center has-checked:border-sky-400 has-checked:bg-sky-950"
              >
                <input
                  type="radio"
                  name="avatarId"
                  value={avatar.id}
                  required
                  defaultChecked={index === 0}
                  className="sr-only"
                />
                <Image
                  src={avatar.src}
                  alt=""
                  width={96}
                  height={96}
                  className="mx-auto h-20 w-20 rounded-full object-cover"
                />
                <span className="mt-2 block text-sm">{avatar.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <button
          type="submit"
          className="mt-8 w-full rounded-md bg-sky-600 px-5 py-3 font-semibold hover:bg-sky-500"
        >
          Create account
        </button>
      </form>
    </main>
  );
}
