import type { Metadata } from "next"

import { OnboardingWizard } from "@/components/onboarding/wizard"

export const metadata: Metadata = { title: "Set up your account | Nanite" }

export default function OnboardingPage() {
  return <OnboardingWizard />
}
