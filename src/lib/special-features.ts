import "server-only";

import { asRows, getDb, transaction } from "./db";

/**
 * Special features: making-ofs, documentaries about a director, retrospectives
 * on an actor. They are ordinary library items, but they are ABOUT something
 * rather than being the thing you sat down to watch, and listing them beside
 * real films makes Browse read like a DVD extras menu.
 *
 * Two separate ideas, deliberately two tables:
 *
 *   MARKED  — in special_features at all. This is what hides it from
 *             discovery, and nothing else. An unmapped feature is a real
 *             state: everything gets marked in one pass and worked out
 *             afterwards, and until then it should be hidden and waiting in
 *             the console rather than either visible or lost.
 *
 *   MAPPED  — rows in special_feature_targets, one per place it should
 *             surface. A making-of can hang off both its film and its
 *             director, and a film page gathers from several directions.
 *
 * Marking never removes anything: a special feature keeps its own item page
 * and stays directly playable. This module only ever answers "should this
 * appear in a list", which is the same line filterVisible() already draws.
 */

export type TargetKind = "film" | "franchise" | "director" | "actor";

const TARGET_KINDS: readonly TargetKind[] = ["film", "franchise", "director", "actor"];

export function isTargetKind(value: string): value is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(value);
}

export interface SpecialFeatureTarget {
  kind: TargetKind;
  targetId: string;
  targetLabel: string | null;
}

export interface SpecialFeature {
  itemId: string;
  title: string | null;
  note: string | null;
  createdAt: number;
  targets: SpecialFeatureTarget[];
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * Every marked item id.
 *
 * Returned as a Set and read on every list render, which is why this is one
 * query of one small table rather than a per-item lookup — the same shape as
 * getExcludedPathSet(), and for the same reason.
 *
 * Keyed on the Jellyfin item id rather than the path, unlike the exclusion
 * tables. Those are keyed on path because a rescan re-mints ids; here the id
 * is what the film page already has in hand, and a re-minted id shows up as a
 * feature that reappears in Browse — visible and fixable — rather than as a
 * mapping that silently points at nothing.
 */
export function getSpecialFeatureIdSet(): Set<string> {
  const rows = asRows<{ jellyfin_item_id: string }>(
    getDb().prepare("SELECT jellyfin_item_id FROM special_features").all(),
  );
  return new Set(rows.map((r) => r.jellyfin_item_id));
}

export function isSpecialFeature(itemId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS present FROM special_features WHERE jellyfin_item_id = ?")
    .get(itemId) as { present: number } | undefined;
  return Boolean(row);
}

export function listSpecialFeatures(): SpecialFeature[] {
  const features = asRows<{
    jellyfin_item_id: string;
    title: string | null;
    note: string | null;
    created_at: number;
  }>(getDb().prepare("SELECT * FROM special_features ORDER BY created_at DESC").all());

  const targets = asRows<{
    jellyfin_item_id: string;
    kind: string;
    target_id: string;
    target_label: string | null;
  }>(getDb().prepare("SELECT * FROM special_feature_targets").all());

  const byItem = new Map<string, SpecialFeatureTarget[]>();
  for (const row of targets) {
    if (!isTargetKind(row.kind)) continue;
    const list = byItem.get(row.jellyfin_item_id) ?? [];
    list.push({ kind: row.kind, targetId: row.target_id, targetLabel: row.target_label });
    byItem.set(row.jellyfin_item_id, list);
  }

  return features.map((f) => ({
    itemId: f.jellyfin_item_id,
    title: f.title,
    note: f.note,
    createdAt: f.created_at,
    targets: byItem.get(f.jellyfin_item_id) ?? [],
  }));
}

/**
 * Which features belong on one film's page.
 *
 * Takes every angle at once because a film page shows all of them together:
 * the making-of mapped to this film, the documentary mapped to its franchise,
 * the profile of its director, the retrospective on one of its leads.
 *
 * Returns ids in a stable order — most specific first — so the film's own
 * making-of leads and a broad actor profile trails, which is the order
 * somebody looking at that page cares about.
 */
export function getFeatureIdsForFilm(input: {
  itemId?: string | null;
  groupIds?: string[];
  directorIds?: string[];
  actorIds?: string[];
}): string[] {
  const clauses: { kind: TargetKind; ids: string[] }[] = [
    { kind: "film", ids: input.itemId ? [input.itemId] : [] },
    { kind: "franchise", ids: input.groupIds ?? [] },
    { kind: "director", ids: input.directorIds ?? [] },
    { kind: "actor", ids: input.actorIds ?? [] },
  ];

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const { kind, ids } of clauses) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) continue;
    const placeholders = unique.map(() => "?").join(", ");
    const rows = asRows<{ jellyfin_item_id: string }>(
      getDb()
        .prepare(
          `SELECT jellyfin_item_id FROM special_feature_targets
           WHERE kind = ? AND target_id IN (${placeholders})`,
        )
        .all(kind, ...unique),
    );
    for (const row of rows) {
      if (seen.has(row.jellyfin_item_id)) continue;
      seen.add(row.jellyfin_item_id);
      ordered.push(row.jellyfin_item_id);
    }
  }
  return ordered;
}

/** Which kinds matched, for labelling a feature on the page it appears on. */
export function getTargetsForFeatures(itemIds: string[]): Map<string, SpecialFeatureTarget[]> {
  const out = new Map<string, SpecialFeatureTarget[]>();
  if (itemIds.length === 0) return out;
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = asRows<{
    jellyfin_item_id: string;
    kind: string;
    target_id: string;
    target_label: string | null;
  }>(
    getDb()
      .prepare(
        `SELECT * FROM special_feature_targets WHERE jellyfin_item_id IN (${placeholders})`,
      )
      .all(...itemIds),
  );
  for (const row of rows) {
    if (!isTargetKind(row.kind)) continue;
    const list = out.get(row.jellyfin_item_id) ?? [];
    list.push({ kind: row.kind, targetId: row.target_id, targetLabel: row.target_label });
    out.set(row.jellyfin_item_id, list);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export function markSpecialFeature(itemId: string, title?: string | null, note?: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO special_features (jellyfin_item_id, title, note, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(jellyfin_item_id) DO UPDATE SET
         title = COALESCE(excluded.title, special_features.title),
         note  = COALESCE(excluded.note, special_features.note)`,
    )
    .run(itemId, title ?? null, note ?? null, Date.now());
}

/** Unmarking drops the mappings too — they mean nothing without the mark. */
export function unmarkSpecialFeature(itemId: string): boolean {
  return transaction(() => {
    getDb().prepare("DELETE FROM special_feature_targets WHERE jellyfin_item_id = ?").run(itemId);
    const result = getDb()
      .prepare("DELETE FROM special_features WHERE jellyfin_item_id = ?")
      .run(itemId);
    return result.changes > 0;
  });
}

export function addTarget(
  itemId: string,
  kind: TargetKind,
  targetId: string,
  targetLabel?: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO special_feature_targets
         (jellyfin_item_id, kind, target_id, target_label, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(jellyfin_item_id, kind, target_id) DO UPDATE SET
         target_label = COALESCE(excluded.target_label, special_feature_targets.target_label)`,
    )
    .run(itemId, kind, targetId, targetLabel ?? null, Date.now());
}

export function removeTarget(itemId: string, kind: TargetKind, targetId: string): boolean {
  const result = getDb()
    .prepare(
      "DELETE FROM special_feature_targets WHERE jellyfin_item_id = ? AND kind = ? AND target_id = ?",
    )
    .run(itemId, kind, targetId);
  return result.changes > 0;
}
