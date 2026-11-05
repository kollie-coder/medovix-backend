/** One spelling per email address: "Ada@Example.com " and "ada@example.com" are the same account. */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}
