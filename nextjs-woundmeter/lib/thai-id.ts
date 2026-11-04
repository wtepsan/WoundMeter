// Thai Citizen ID helpers for form feedback. The server re-validates every value.

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "").slice(0, 13);
}

export function isValidThaiCitizenId(value: string): boolean {
  const d = digitsOnly(value);
  if (d.length !== 13) return false;
  const sum = d
    .slice(0, 12)
    .split("")
    .reduce((acc, digit, i) => acc + Number(digit) * (13 - i), 0);
  return (11 - (sum % 11)) % 10 === Number(d[12]);
}

/** Display as 1-2345-67890-12-3 while typing. */
export function formatThaiCitizenId(value: string): string {
  const d = digitsOnly(value);
  const parts = [d.slice(0, 1), d.slice(1, 5), d.slice(5, 10), d.slice(10, 12), d.slice(12, 13)];
  return parts.filter(Boolean).join("-");
}
