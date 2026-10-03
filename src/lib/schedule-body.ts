import type { Schedule } from "./job-schedule";
import { optionalInt, optionalString, ValidationError } from "./validation";

/** Reads cadence / hour / minute / weekday / month_day off a console request. Times are IST. */
export function scheduleFromBody(body: Record<string, unknown>): Schedule {
  const cadence = optionalString(body, "cadence");
  if (cadence !== "daily" && cadence !== "weekly" && cadence !== "monthly") {
    throw new ValidationError("Choose daily, weekly or monthly.");
  }
  return {
    cadence,
    hour: optionalInt(body, "hour") ?? -1,
    minute: optionalInt(body, "minute") ?? -1,
    weekday: optionalInt(body, "weekday") ?? null,
    monthDay: optionalInt(body, "month_day") ?? null,
  };
}
