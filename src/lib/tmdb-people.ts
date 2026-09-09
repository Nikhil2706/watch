import "server-only";

import type { DatabaseSync } from "node:sqlite";

import { asRows, getDb, transaction } from "./db";
import { creditsFromPayload, type Department, type ShapedCredit } from "./tmdb-shape";

/**
 * Where a crew member lives.
 *
 * The film page has had Cinematography and Editing rows since they were
 * written, and both have always rendered empty: Jellyfin holds zero people of
 * either type across all 1,181 items. It stores Director, Actor, Writer and
 * Producer, nothing else. So the data to fill those rows exists only inside
 * TMDB payloads, and a person from there has no Jellyfin id — which means no
 * photo, and no /person/{id} to link to. Two symptoms, one cause.
 *
 * This module is the cause removed. A person becomes a row keyed on their TMDB
 * id, their credits become rows keyed the same way tmdb_links keys everything
 * (path for a file, group for a show), and their photo is served from
 * tmdb_images. After that a cinematographer is as real as an actor.
 *
 * Ingest is deliberately a pure function of one cached payload — no network, no
 * ordering requirement, safe to re-run. Every call replaces that subject's
 * credits wholesale, so a re-identified film cannot leave the previous film's
 * crew behind. (That exact failure has bitten this codebase before, with a
 * backdrop that outlived the match that put it there.)
 */

export interface PersonRow {
  tmdbId: number;
  name: string;
  profilePath: string | null;
}

/** A credit as stored, joined back to the person who holds it. */
export type SubjectCredit = ShapedCredit;

export interface PersonCredit {
  subjectType: "path" | "group";
  subjectId: string;
  department: Department;
  job: string;
}

/**
 * Store one subject's people and credits, replacing whatever was there.
 *
 * Returns how many credits were written, which is what the admin route reports
 * and what makes a dry run legible.
 */
export function ingestCredits(
  subjectType: "path" | "group",
  subjectId: string,
  payload: unknown,
): number {
  return transaction((db) => applyCredits(db, subjectType, subjectId, payload));
}

/**
 * The write itself, without a transaction of its own.
 *
 * Split out because transaction() uses BEGIN IMMEDIATE and does not nest, and
 * the sweep below wants one transaction across the whole library rather than
 * 400 — which on this host's disk is the difference worth caring about.
 */
function applyCredits(
  db: DatabaseSync,
  subjectType: "path" | "group",
  subjectId: string,
  payload: unknown,
): number {
  const credits = creditsFromPayload(payload);

  // Wholesale replace, not merge. If this film was re-identified, the previous
  // film's crew must not survive underneath the new one's.
  db.prepare("DELETE FROM tmdb_credits WHERE subject_type = ? AND subject_id = ?").run(
    subjectType,
    subjectId,
  );

  const person = db.prepare(
    `INSERT INTO tmdb_people (tmdb_id, name, profile_path, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tmdb_id) DO UPDATE SET
       name = excluded.name,
       profile_path = excluded.profile_path,
       updated_at = excluded.updated_at`,
  );
  const credit = db.prepare(
    `INSERT INTO tmdb_credits (tmdb_person_id, subject_type, subject_id, department, job, ord)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tmdb_person_id, subject_type, subject_id, department, job)
     DO UPDATE SET ord = excluded.ord`,
  );

  const now = Date.now();
  for (const c of credits) {
    person.run(c.tmdbId, c.name, c.profilePath, now);
    credit.run(c.tmdbId, subjectType, subjectId, c.department, c.job, c.ord);
  }
  return credits.length;
}

export interface IngestResult {
  subjects: number;
  credits: number;
  skippedNoPayload: number;
  /** People known only from a season payload — no credits, just a face. */
  episodePeople: number;
}

interface RawSeasonPerson {
  id?: number;
  name?: string;
  profile_path?: string | null;
}

/**
 * Everyone who appears in a season payload, as people only.
 *
 * An episode's own crew and guest stars are rendered from the season payload
 * directly, so they need no credit rows — but the photo route resolves a
 * profile path out of tmdb_people, so without a row there they would all fall
 * back to initials. This gives them the row and nothing else.
 *
 * Deliberately not credits: 628 episode files times a dozen names each would
 * double the credits table to say what the group already says.
 */
function upsertSeasonPeople(db: DatabaseSync): number {
  const rows = asRows<{ payload: string }>(
    getDb().prepare("SELECT payload FROM tmdb_cache WHERE kind = 'season'").all(),
  );

  const person = db.prepare(
    `INSERT INTO tmdb_people (tmdb_id, name, profile_path, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tmdb_id) DO UPDATE SET
       name = excluded.name,
       profile_path = excluded.profile_path,
       updated_at = excluded.updated_at`,
  );

  const now = Date.now();
  const seen = new Set<number>();
  for (const row of rows) {
    let payload: { episodes?: Array<{ crew?: RawSeasonPerson[]; guest_stars?: RawSeasonPerson[] }> };
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    for (const ep of payload.episodes ?? []) {
      for (const c of [...(ep.crew ?? []), ...(ep.guest_stars ?? [])]) {
        if (typeof c.id !== "number" || !c.name || seen.has(c.id)) continue;
        seen.add(c.id);
        person.run(c.id, c.name, c.profile_path ?? null, now);
      }
    }
  }
  return seen.size;
}

/**
 * Fill the tables from what is already cached. No network at all.
 *
 * This is the whole point of having stored the raw payload verbatim: the crew
 * for 390 films and 15 shows is already on this disk, fetched last week, and
 * turning it into rows is a SQL pass rather than another 400 requests over a
 * link that drops one in thirty.
 *
 * Two kinds of subject are read, and one is deliberately skipped:
 *   - a path with no season   — a film, credits from its movie payload
 *   - a group                 — a show, credits from its aggregate_credits
 *   - a path WITH a season    — an episode file, skipped on purpose. Its link
 *     points at the show, so ingesting it would copy the entire series cast
 *     onto each of 628 files to say nothing the group does not already say.
 *
 * Idempotent: every subject's credits are replaced, so running it twice is the
 * same as running it once, and re-running after a re-identification is how a
 * stale crew gets corrected.
 */
export function ingestAllFromCache(): IngestResult {
  const rows = asRows<{ subject_type: "path" | "group"; subject_id: string; payload: string }>(
    getDb()
      .prepare(
        `SELECT l.subject_type, l.subject_id, c.payload
           FROM tmdb_links l
           JOIN tmdb_cache c
             ON c.kind = l.tmdb_kind
            AND c.tmdb_id = l.tmdb_id
            AND c.season = -1
            AND c.episode = -1
          WHERE l.subject_type IN ('path', 'group')
            AND l.tmdb_id > 0
            AND l.season IS NULL`,
      )
      .all(),
  );

  let subjects = 0;
  let credits = 0;
  let skippedNoPayload = 0;
  let episodePeople = 0;

  transaction((db) => {
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        // A payload that will not parse is a cache problem, not a people
        // problem — leave it for the store to refetch and carry on.
        skippedNoPayload += 1;
        continue;
      }
      credits += applyCredits(db, row.subject_type, row.subject_id, payload);
      subjects += 1;
    }
    episodePeople = upsertSeasonPeople(db);
    return null;
  });

  return { subjects, credits, skippedNoPayload, episodePeople };
}

/** Everyone credited on one library subject, cast first and then by bucket. */
export function creditsForSubject(
  subjectType: "path" | "group",
  subjectId: string,
): SubjectCredit[] {
  return asRows<{
    tmdb_id: number;
    name: string;
    profile_path: string | null;
    department: Department;
    job: string;
    ord: number;
  }>(
    getDb()
      .prepare(
        `SELECT p.tmdb_id, p.name, p.profile_path, c.department, c.job, c.ord
           FROM tmdb_credits c
           JOIN tmdb_people p ON p.tmdb_id = c.tmdb_person_id
          WHERE c.subject_type = ? AND c.subject_id = ?
          ORDER BY c.department, c.ord, p.name`,
      )
      .all(subjectType, subjectId),
  ).map((r) => ({
    tmdbId: r.tmdb_id,
    name: r.name,
    profilePath: r.profile_path,
    department: r.department,
    job: r.job,
    ord: r.ord,
  }));
}

export function personById(tmdbId: number): PersonRow | null {
  const rows = asRows<{ tmdb_id: number; name: string; profile_path: string | null }>(
    getDb()
      .prepare("SELECT tmdb_id, name, profile_path FROM tmdb_people WHERE tmdb_id = ?")
      .all(tmdbId),
  );
  const row = rows[0];
  return row ? { tmdbId: row.tmdb_id, name: row.name, profilePath: row.profile_path } : null;
}

/** Everything in this library one person is credited on. */
export function creditsForPerson(tmdbId: number): PersonCredit[] {
  return asRows<{
    subject_type: "path" | "group";
    subject_id: string;
    department: Department;
    job: string;
  }>(
    getDb()
      .prepare(
        `SELECT subject_type, subject_id, department, job
           FROM tmdb_credits
          WHERE tmdb_person_id = ?
          ORDER BY department, subject_id`,
      )
      .all(tmdbId),
  ).map((r) => ({
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    department: r.department,
    job: r.job,
  }));
}

/**
 * Where a card should point its <img>.
 *
 * A same-origin path, never image.tmdb.org — see tmdb-images.ts for why that
 * matters here. Null for a person TMDB has no photo of, which is the caller's
 * cue to render initials exactly as CastRow already does.
 */
export function personPhotoHref(person: PersonRow, size = "w185"): string | null {
  if (!person.profilePath) return null;
  return `/api/person-photo/${person.tmdbId}?size=${encodeURIComponent(size)}`;
}

export interface PeopleStats {
  people: number;
  credits: number;
  withPhoto: number;
}

export function peopleStats(): PeopleStats {
  const db = getDb();
  const people = asRows<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM tmdb_people").all(),
  )[0];
  const photos = asRows<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM tmdb_people WHERE profile_path IS NOT NULL").all(),
  )[0];
  const credits = asRows<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM tmdb_credits").all(),
  )[0];
  return {
    people: people?.n ?? 0,
    credits: credits?.n ?? 0,
    withPhoto: photos?.n ?? 0,
  };
}
