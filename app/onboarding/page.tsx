import Link from "next/link";

export default function OnboardingPage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div>
        <h1 className="text-3xl font-bold">Onboarding</h1>
        <p className="mt-3 text-muted-foreground">
          Account onboarding is coming soon.
        </p>
        <Link href="/" className="mt-6 inline-block underline underline-offset-4">
          Back home
        </Link>
      </div>
    </main>
  );
}
