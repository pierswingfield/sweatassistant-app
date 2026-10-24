# Isolated MCP staging monitoring

This stack is for `sweatassistant-mcp-stage` only. Prometheus is the only monitoring
container attached to the stage's internal app network; it scrapes the existing
authenticated `/metrics` endpoint. Grafana, Alertmanager and the bounded receiver
use a separate internal Docker network. Grafana is the only host-published service
and binds to Oracle Tailnet IPv4 `100.86.226.52:3031`; built-in authentication is
required and anonymous access/sign-up are disabled. No internet route, public
interface, app restart, gym request, or external notification destination is set.

Each container has a fixed ARM64 image-manifest digest, read-only root filesystem,
removed Linux capabilities, no-new-privileges, CPU/memory/PID limits and capped
JSON logs. The stack reserves 896 MiB memory total. Prometheus retains at most
7 days / 512 MB of samples. Persistent state is limited to task-owned directories.

`receiver.js` accepts only authenticated Alertmanager POSTs, with a 32 KiB body cap,
20-alert cap, fixed alert-name/status allowlists, no request logging, and durable
aggregate counts only. It measures free space on its own state directory filesystem.
The synthetic acceptance check proves only internal Prometheus → Alertmanager →
receiver delivery; it does not create a notification or represent real client traffic.

The source-of-truth configs live in this directory. On Oracle they are installed
under `/home/ubuntu/services/sweatassistant-mcp-stage/monitoring`; secrets are
separate mode-0600 host files and must never be committed. See
`Documentation/Operations/MCP-STAGING.md` for the operator sequence.


## Operator validation and rollback

Run the standalone receiver checks with `node --test Documentation/Operations/mcp-stage-monitoring/receiver.test.js`. The deployed Prometheus config and rules were checked with `promtool check config`; Alertmanager config was checked with `amtool check-config`. The private dashboard is at `http://100.86.226.52:3031/d/mcp-stage-ops/mcp-staging-operations` (UID `mcp-stage-ops`); username is `mcp-stage-ops` and the generated password is stored only in host file `/home/ubuntu/services/sweatassistant-mcp-stage/monitoring/.env.grafana` (mode 0600). External Tailnet browser access still needs a human acceptance check.

To stop/remove only these monitoring containers, run `docker compose -p sweatassistant-mcp-stage-ops -f /home/ubuntu/services/sweatassistant-mcp-stage/monitoring/docker-compose.yml down`; this retains their bind-mounted data and does not affect the separate stage app project. Do not use `--remove-orphans` against the app project's Compose file. Recreate with the same command and `up -d`. The stage app's existing provider-read kill switch remains `MCP_PROVIDER_READS_ENABLED=false`; it was not changed or exercised here. No human alert destination is configured.
