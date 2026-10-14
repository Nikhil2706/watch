/**
 * A poster in an admin list. posterUrl is an absolute external URL (a group's
 * OMDb art) or a signed /api/admin/thumb path, both fine from this origin.
 */
export function Thumb({ url, className }: { url: string | null | undefined; className: string }) {
  if (!url) return <span className={`${className} adm-thumb-empty`} aria-hidden="true" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={url} alt="" loading="lazy" />;
}
