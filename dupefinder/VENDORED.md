# Vendored: VDF.Core

`VDF.Core/` in this directory is copied verbatim (no modifications) from
[0x90d/videoduplicatefinder](https://github.com/0x90d/videoduplicatefinder),
pinned at commit `657605427548d37f4b49402cd57b152588671c0a` (master,
2026-09-05). It is the detection engine only — none of VDF.GUI, VDF.CLI, or
VDF.Web is included; `DupeFinder.Api/` is this project's own thin wrapper
around it, not a fork of any of those.

Copied in rather than a git submodule: this repo is worked on from both a
Windows checkout and Ubuntu/WSL, and a submodule pointer is one more thing to
go stale or mis-checkout across that split. To pick up an upstream update,
re-run:

```
git clone https://github.com/0x90d/videoduplicatefinder.git /tmp/vdf
cd /tmp/vdf && git checkout <new-commit>
rm -rf <this-repo>/dupefinder/VDF.Core
cp -r VDF.Core <this-repo>/dupefinder/VDF.Core
rm -rf <this-repo>/dupefinder/VDF.Core/bin <this-repo>/dupefinder/VDF.Core/obj
```
and update the pinned commit above.

## License

Every source file under `VDF.Core/` carries a GNU Affero General Public
License v3 (or later) header in the file itself. The upstream repository has
no top-level `LICENSE`/`COPYING` file for GitHub to detect (confirmed via the
GitHub API, 2026-09-05), so the per-file header is the operative grant.
`VDF.Core/` is reproduced here unmodified; the only new code is
`DupeFinder.Api/`, a separate program that uses it as a library.

Per the integration handoff (`../vdf_jellyfin_gate_handoff.md`): this ships
as an internal sidecar on jellyfin-gate's own Docker network, not exposed
through the Cloudflare tunnel, for personal/family use. That makes the
AGPLv3 network-use clause a non-issue in practice today — flag it again if
jellyfin-gate's own hosting or distribution posture ever changes.
