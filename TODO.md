# TODO

Work deliberately left for later. Each line says what unblocks it.

- **Backups stop the whole cluster.** The weekly snapshot (ADR-024, Sunday
  03:30 UTC) runs `k3s-killall` so nothing writes during the tar: every app
  and public site is down for 2 to 4 minutes (74 s of k3s down on
  2026-10-25, then the pods' restart). The snapshot is crash-consistent, not a
  clean shutdown, and a week of data is the most a loss costs.
  - Candidate fix, open to other ideas: dump the databases hot, nightly,
    without stopping anything: `pg_dump` in op-postgres, SQLite's `.backup`
    in signews-api and studio-console, each through `kubectl exec`, then
    age-encrypted like today. About 700 MB of data, a few hundred MB
    compressed. A loss then costs a day, and a `pg_dump` restores into a
    newer PostgreSQL major, which a file copy does not. The cold full copy
    stays for the telemetry stores (VictoriaMetrics is 1.7 GB of the ~2.9 GB)
    and drops to monthly.
  - Ruled out for now: an APFS snapshot of the Mac's disk (zero downtime, but
    it runs on the Mac under launchd and sudo, outside the VM and Ansible).
- **Offsite backup.** The snapshots sit on the Mac, beside the data: a lost
  disk loses both. Backblaze B2 is the pick (10 GB free, then $6/TB/month,
  restores free up to 3x the stored volume; a provider other than Cloudflare,
  so losing that account loses no backup); R2 is the simpler fallback (10 GB
  free, same account as DNS and the tunnel). Needs the account and a
  bucket-scoped key in Infisical; the archives are already age-encrypted.
  Ships the nightly dumps above, not the telemetry.
- **The cluster moves to a station server.** The owner's vision (accepted
  2026-11-20, its five recommendations on 2026-11-21): the machine is a
  Debian 13 server that station builds from its Machinefile on the Mac
  mini, and CI is the only deployer of what runs on it (`site.yml`, then
  `platform.yml`, as root over ssh across `tailscale0`). Secrets stay on the
  runner (ADR-015 kept); no GitOps, the VM never clones this repository, and
  `make deploy` from a Mac goes. The machine's half (base apt, UTC,
  unattended-upgrades, sshd hardening, the CI's public key, systemd-resolved,
  sysctls, the modprobe blacklist, Tailscale joined by a vault grant, a data
  disk) is station's: its lots S1 to S6 are in jterrazz/spwn's
  `machines/TODO.md`, "studio-infrastructure on a station server".
  - A rehearsal on 2026-11-20 deployed the whole stack from a CI stand-in
    onto a bare Debian 13 arm64 node with fake secrets: k3s Ready, 33
    releases, 8 of 8 PVs Bound, 5 of 6 host specs, a backup written; about
    2.6 GiB of working set (a lower bound), 12 GB of disk, a cold deploy in
    about 3 min plus pulls. It broke three times: k3s pins
    `/run/systemd/resolve/resolv.conf` (no pod starts without it), a
    `DirectoryOrCreate` volume on ext4 is `root 0755` (five stateful
    workloads crash-looped), and the guard's `eth0` and `192.168.139.1` are
    OrbStack's. Also: `/etc/modprobe.d` is absent on a bare trixie, nftables
    comes only as a Recommends of iptables, and `lookup('env','USER')` is
    the controller's user.
  - I0, the Machinefile: `machinefiles/studio-node.machine.yaml` extends
    station's `base-debian`, 16 CPU and 30 GB (the new Mac mini M5 Pro), a
    data disk at `/srv/data` with k3s's local-path at `/srv/data/k3s`, and
    the settings with this repository's values (the sysctls of
    `security/defaults`, upstreams 1.1.1.1 and 9.9.9.9, the CI key). Proof:
    a new host spec beside `specs/specs/host/sshd/` reading it and the
    node.
  - I1, the roles cut: `site.yml` loses `resolved` and `tailscale` (keeping
    `tailscale/tasks/facts.yml` where k3s, cluster and cloudflare read it),
    `base` shrinks to the CI's apt list plus nftables and the data link with
    a `mountpoint -q` check, `security` to the guard, and the site-scoped
    OAuth pair leaves `group_vars/all/secrets.yml`. Proof: `make check`, the
    k3d upgrade test (ADR-021), the Host contract.
  - I2, k3s asserts the resolver file before its install (break 1 becomes a
    red play, not a 515 s hang) and gains `RequiresMountsFor=/srv/data`.
  - I3, chart ownership, needed on the ext4 data disk (break 2): a root init
    container with CHOWN alone in the app chart, allowed by the enforced
    baseline (`k3s/templates/pod-security.yaml.j2`, whose
    "fix-permissions" note is stale), and the `cluster` role creating each
    platform PV's directory with its owner. Proof: helm unittest snapshots,
    the k3d upgrade test with the stateful pods Ready. HYPOTHESIS
    (2026-11-20): k3d's hostPath enforces ownership as ext4 did.
  - I4, Deploy runs `site.yml`; the hazard at `deploy.yaml:4-5` goes (the
    rehearsal saw an sshd restart mid-play kept by ControlPersist), with
    `make deploy`, `src/scripts/deploy.sh` and `inventories/laptop.yml`.
  - I5, the guard re-pointed: the interface and gateway come from
    `ansible_default_ipv4`, accepting `tailscale0` on 22, 80, 443 and 6443
    and the Mac mini's NAT gateway on 22 and 6443 alone; the guard spec
    reads them from the node.
  - I6, the OrbStack lines go: the Makefile's `orbctl` targets and
    `kubectl.ts`, `helmfile.sh`, `backup.sh`, the 198.19.0.0/16 network
    policy with its snapshots, `/mnt/mac` and `eth0` in the node alerts and
    dashboard, the guard's `[::1]` reset (ADR-006), the skill, the README,
    and the write-through unit if
    station's fsync measure on the data disk says so (HYPOTHESIS,
    2026-11-20: tart pays OrbStack's tax).
  - I7, the ADRs, Proposed until the owner accepts: a new ADR-031 (one
    station server is the only target, CI deploys all of it), superseding
    004 and 008; amendments to 006 (the guard's addresses from the default
    route, sshd's hardening the Machinefile's) and 015 (the OAuth pair
    leaves, the join is the machine's).
  - The cutover, by the owner on the new Mac mini, never with OrbStack and
    the server running together:
    - inventory `helm list -A` against the app repositories' deploys, take
      a final age backup and copy it off the Mac, `orbctl stop` (never
      delete), and rename the old device in Tailscale;
    - create the server, grant it the Tailscale key (one-off,
      pre-approved, `tag:cluster`, a day), run Deploy, then each app's
      deploy, and check Watch, `make test` and every PV Bound;
    - rollback: stop the server, `orbctl start`. The OrbStack VM is
      deleted after a week of green Watch;
    - the old Mac mini is a test bench until then, its test server under
      its own name, never on 80, 443 or 6443.
  - HYPOTHESIS (2026-11-20): every app release is rebuilt by re-running its
    repository's deploy; settled by that inventory before the window. Open:
    the plan restored by mounting the same data folder; with a data disk,
    how today's data reaches it is not decided.
  - Starts with I0 once station's S1, S2 and S6 have landed; I1 to I7
    follow, then the cutover with all lots merged.
