// Who may use which paid features of the mobile app.
//
// RULE
//  - Before the paywall date, EVERYONE has access.
//  - From the paywall date on, anyone whose account was created BEFORE that
//    date keeps access for good (early members).
//  - Everyone else needs an active PREMIUM plan.
//
// The paywall date comes from the env var PREMIUM_PAYWALL_STARTS_AT (an ISO
// date such as 2027-01-01). Leave it unset and the paywall is off.

export interface PlanFields {
  plan: 'FREE' | 'PREMIUM'
  planExpiresAt: Date | null
  createdAt: Date
}

function paywallStartsAt(): Date | null {
  const raw = process.env.PREMIUM_PAYWALL_STARTS_AT
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export function isEarlyMember(user: Pick<PlanFields, 'createdAt'>): boolean {
  const start = paywallStartsAt()
  return !!start && user.createdAt < start
}

export function hasActivePremium(
  user: Pick<PlanFields, 'plan' | 'planExpiresAt'>,
  now = new Date(),
): boolean {
  if (user.plan !== 'PREMIUM') return false
  return !user.planExpiresAt || user.planExpiresAt > now
}

export function canUseDietLogging(user: PlanFields, now = new Date()): boolean {
  const start = paywallStartsAt()
  if (!start || now < start) return true // paywall not live yet
  return isEarlyMember(user) || hasActivePremium(user, now)
}