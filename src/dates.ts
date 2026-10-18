// Calendar dates as YYYY-MM-DD strings. The arithmetic is done in UTC so results don't
// depend on the server's time zone (UTC on Lambda, the user's own for the stdio server).

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 0 = Sunday
export function dayOfWeek(date: string): number {
  return new Date(date + "T00:00:00Z").getUTCDay();
}

export function getMonday(date: string): string {
  const day = dayOfWeek(date);
  return addDays(date, day === 0 ? -6 : 1 - day);
}

// Today's date in the given IANA time zone (the server's own when omitted)
export function todayIn(timeZone?: string): string {
  try {
    // en-CA formats dates as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
