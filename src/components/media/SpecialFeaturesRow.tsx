import Link from "next/link";

import { formatRuntime, posterUrl, type MediaItem } from "@/lib/media";
import { itemHref } from "@/lib/slugs";
import type { SpecialFeatureTarget } from "@/lib/special-features";

/**
 * Special features on a film's page — the making-of, the documentary about
 * its director, the retrospective on one of its leads.
 *
 * Each one says why it is here. A viewer looking at Blade Runner should be
 * able to tell at a glance that one of these is about this film and another
 * is about Ridley Scott generally, because that decides whether it is worth
 * their next hour. Without the label the row is just a pile of documentaries.
 */
export function SpecialFeaturesRow({
  features,
}: {
  features: { item: MediaItem; targets: SpecialFeatureTarget[] }[];
}) {
  if (features.length === 0) return null;

  return (
    <section className="sf-section">
      <h2 className="sf-heading">Special features</h2>
      <ul className="sf-list">
        {features.map(({ item, targets }) => {
          const poster = posterUrl(item, 220);
          const runtime = formatRuntime(item.RunTimeTicks);
          return (
            <li key={item.Id} className="sf-card">
              <Link
                href={itemHref(item.Id, item.Name, item.ProductionYear)}
                className="sf-link"
              >
                {poster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="sf-art" src={poster} alt="" loading="lazy" />
                ) : (
                  <div className="sf-art sf-art-empty" aria-hidden="true" />
                )}
                <div className="sf-body">
                  <div className="sf-title">{item.Name}</div>
                  <div className="sf-meta">
                    {[item.ProductionYear, runtime].filter(Boolean).join(" · ")}
                  </div>
                  <div className="sf-why">{describeTargets(targets)}</div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Why this feature is on this page.
 *
 * A feature can be mapped several ways at once, but only the most specific
 * reason is worth showing — "About this film" beats "About Ridley Scott" when
 * both are true, because the first is why it is at the top of the row.
 */
function describeTargets(targets: SpecialFeatureTarget[]): string {
  const byKind = new Map(targets.map((t) => [t.kind, t]));

  if (byKind.has("film")) return "About this film";

  const franchise = byKind.get("franchise");
  if (franchise) {
    return franchise.targetLabel ? `About ${franchise.targetLabel}` : "About this series";
  }

  const director = byKind.get("director");
  if (director) {
    return director.targetLabel ? `About ${director.targetLabel}` : "About the director";
  }

  const actor = byKind.get("actor");
  if (actor) {
    return actor.targetLabel ? `About ${actor.targetLabel}` : "About one of the cast";
  }

  return "Related";
}
