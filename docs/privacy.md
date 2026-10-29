# Privacy

PUFFR runs inside the unmodified Claude Code CLI under your own login. It doesn't wrap, patch, or
proxy the `claude` binary, and it never handles OAuth tokens or credentials.

## What it reads

Only files on your machine that Claude Code or Codex already wrote:

- session transcripts under `~/.claude/projects`,
- the account profile in each `.claude.json`: email, organization name, and plan type, never
  tokens,
- Codex rollouts under `$CODEX_HOME/sessions`,
- a UCEF data directory (`.claude/data` or `--ucef-data-dir`), only when you open the UCEF view,
  read-only and locally.

## What it writes

Only to `~/.puffr` (settings, the radar index, session metadata, saved transcripts) and
`~/.cache/puffr` (git status, window size, cache TTL tier, and last-seen usage per account). Both
are private to your user, and puffr skips writing if the cache folder isn't owned by you. It never
moves or deletes a transcript. The full list is in
[configuration.md](configuration.md#files).

## What leaves your machine

Four features call Haiku through your own `claude` login, so their input goes to Anthropic. Nothing
else is sent anywhere.

| Feature | Default | Sends |
|---|---|---|
| **Autoname** | On. `puffr-config off autoname` turns it off. | A session's first prompts, its folder, and your past session titles |
| **Haiku labels** | Off until you say yes | Session titles and first-prompt snippets |
| **Report rules** | Off until `model.haiku` is `on` and you add a rule | Your rules and the project and tag names they may change; account labels only when a rule mentions accounts |
| **Panel insights** | Off until `model.haiku` is `on` | A usage summary: spend by model and project, the measured levers and practices, and the titles, costs, and message counts of your 15 most recent sessions |

None of them sends a transcript. The label call runs without tools, MCP servers, or saved
settings, and isn't saved as a session.

`puffr-update` and the installer fetch the release from GitHub. The browser panel listens on
127.0.0.1 only. Reports, the HUD, the radar, and the UCEF view make no network calls.

## What reaches your terminal and Claude

Text that comes from transcripts, repos, or config (titles, paths, branch names, emails, model
names) is stripped of terminal control characters, including C1 and carriage returns, before it
reaches your terminal or Claude's context. The skills tell Claude never to follow instructions
that appear inside paths or titles from transcripts.

The UCEF view shows hook, agent, and gate metadata rather than message bodies, and scrubs
secret-shaped text by default (`--ucef-no-redact` turns that off).

## Other people's sessions

Each user authenticates with their own account. Don't point PUFFR at other people's sessions.
