import { describeJob, etaSeconds, formatEta, type MediaJob } from "@/lib/jobs";

import { JobControl } from "./JobControl";

/**
 * Titles that have been dropped in but are not playable yet.
 *
 * Rendered as plain <div>s, not links: there is nothing to navigate to, because
 * the file has not reached Jellyfin's library and therefore has no item id. A
 * disabled-looking card that does nothing when tapped is the honest
 * representation of that state, and it beats a title silently materialising an
 * hour later with no explanation.
 *
 * This sits at the bottom of the home page on purpose — it is operational
 * detail, and nobody arriving to watch something should meet a progress bar
 * before they meet the library.
 */
export function ProcessingRow({ jobs }: { jobs: MediaJob[] }) {
  if (jobs.length === 0) return null;

  return (
    <section className="row processing-row" aria-label="Processing">
      <h2>
        Processing
        <span className="row-note">
          {" "}
          — new titles being prepared, not playable yet
        </span>
      </h2>
      <div className="row-scroll">
        {jobs.map((job) => {
          const eta = formatEta(etaSeconds(job));
          return (
            <div
              key={job.id}
              className={`poster processing${job.status === "paused" ? " is-paused" : ""}`}
              aria-disabled="true"
            >
              <div className="poster-art">
                <div className="fallback">
                  {job.status === "paused" ? (
                    <span className="paused-mark" aria-hidden="true">
                      ⏸
                    </span>
                  ) : (
                    <span className="spinner" aria-hidden="true" />
                  )}
                  {job.title}
                </div>
                {job.progress > 0 ? (
                  <div
                    className="progress"
                    role="progressbar"
                    aria-valuenow={job.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${job.progress}% converted`}
                  >
                    <span style={{ width: `${job.progress}%` }} />
                  </div>
                ) : null}
              </div>

              <div className="poster-title">{job.title}</div>
              <div className="poster-sub">{describeJob(job)}</div>
              {/* Only shown once there is enough progress for the estimate to
                  mean anything; see etaSeconds. */}
              {eta && job.status === "running" ? (
                <div className="poster-eta">{eta}</div>
              ) : null}

              <JobControl
                jobId={job.id}
                status={job.status as "pending" | "running" | "paused"}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
