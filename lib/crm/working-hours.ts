import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { DEFAULT_WORKING_HOURS, readWorkingHours, WORKING_HOURS_INVALID, type WorkingHours } from "@/lib/working-hours";

type Row = { weekday: number; works: boolean; starts_minute: number; ends_minute: number };

export async function readWorkingHoursInDb(db: Db, userId: string): Promise<WorkingHours> {
  const rows = (
    await db.query<Row>("select weekday, works, starts_minute, ends_minute from crm.working_hours where user_id = $1", [userId])
  ).rows;
  const hours = DEFAULT_WORKING_HOURS.map((day) => ({ ...day }));
  for (const row of rows) {
    if (row.weekday >= 0 && row.weekday <= 6) hours[row.weekday] = { works: row.works, start: row.starts_minute, end: row.ends_minute };
  }
  return hours;
}

export async function getWorkingHours(actor: UserActor): Promise<WorkingHours> {
  return withActor(actor, (db) => readWorkingHoursInDb(db, actor.userId));
}

export async function saveWorkingHours(actor: UserActor, raw: unknown): Promise<WorkingHours> {
  const hours = readWorkingHours(raw);
  if (!hours) throw new CrmError("invalid_input", WORKING_HOURS_INVALID, 400, { field: "workingHours" });
  return withActor(actor, async (db) => {
    await db.query(
      `insert into crm.working_hours (user_id, weekday, works, starts_minute, ends_minute)
       select $1, day.weekday, day.works, day.starts_minute, day.ends_minute
       from unnest($2::smallint[], $3::boolean[], $4::int[], $5::int[]) as day(weekday, works, starts_minute, ends_minute)
       on conflict (user_id, weekday) do update
         set works = excluded.works, starts_minute = excluded.starts_minute, ends_minute = excluded.ends_minute`,
      [
        actor.userId,
        hours.map((_, index) => index),
        hours.map((day) => day.works),
        hours.map((day) => day.start),
        hours.map((day) => day.end),
      ],
    );
    return readWorkingHoursInDb(db, actor.userId);
  });
}
