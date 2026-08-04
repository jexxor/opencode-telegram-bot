# OpenCode Telegram Bot Fork

Personal fork of [OpenCode Telegram Bot](https://github.com/grinev/opencode-telegram-bot).
It connects Telegram to an OpenCode server running on the bot machine.

This fork is maintained for personal use. It is not published as a ready-to-run
npm package.

## Fork Changes

Compared with upstream, this fork implements:

- **Markdown diff files**: `write` and `edit` tool results are sent as `.md`
  documents instead of `.txt` files. Their content is wrapped in triple
  backticks so Telegram Markdown does not reinterpret file contents.
- **Concurrent session tracking**: sessions in the selected project are tracked
  independently instead of treating one busy session as the only active state.
- **Session status display**: `/sessions`, `/status`, and the pinned status
  message show each tracked session as `Working`, `Access`, or `Finished`.
- **Session switching while busy**: `/sessions`, `/new`, and session-selection
  buttons remain usable while another session is running.
- **Busy-state cleanup**: idle and error events from non-current sessions clear
  their stale local busy state.
- **Session-bound scheduled tasks**: `/task` captures the open session and every
  run continues that conversation instead of creating an execution session.
- **Agent loops**: `/loop` builds an ordered, repeating session pipeline with a
  shared prompt and fixed interval; `/loops` runs, stops, or deletes pipelines.
- **Nested missions**: `/mission` composes reusable sub-missions and OpenCode
  session trees; `/missions` runs and manages them with bounded concurrency.
- **Bot update filtering**: updates originating from the bot itself are ignored.
- **No npm publishing**: the upstream automatic publish workflow was removed.
- **Fork version**: package version is `0.22.5-fork`.

The rest of the bot functionality comes from upstream.

## Upstream Functionality Included

- Send prompts to OpenCode and receive responses in Telegram.
- Create, select, rename, detach, abort, revert, and fork sessions.
- Select projects and git worktrees.
- Switch model, agent, variant, and context settings.
- Follow an OpenCode session running in another TUI or terminal client.
- Receive questions, permission requests, and background-session notifications.
- View live progress and pinned project/session status.
- Run built-in and custom commands, skills, and MCP actions.
- Schedule one-time or recurring tasks bound to the active session.
- Send images, documents, and text files to OpenCode.
- Optionally use voice transcription and audio replies.
- Browse and download project files with `/ls`.
- Use localized UI: `en`, `ar`, `de`, `es`, `fr`, `pt`, `ru`, `zh`.
- Restrict access to one Telegram user ID.

## Rebase Workflow

`.github/workflows/rebase-upstream.yml` is the fork's only automated workflow.
It is not a test or release pipeline.

It runs monthly on the first day at `03:00 UTC` or manually through GitHub Actions and:

1. Checks out fork `main` with full history.
2. Fetches `main` from `https://github.com/grinev/opencode-telegram-bot.git`.
3. Rebases fork `main` onto upstream `main`.
4. Pushes the rebased branch back with `--force-with-lease`.

The reason is simple: the author does not actively maintain this project. The
fork exists for personal use, so automatic rebasing keeps it close to upstream
without requiring manual synchronization. If upstream changes conflict with
fork changes, the workflow fails and the conflict must be resolved manually.

There is no automatic npm publish. The bot is built and run from this source
repository.

## Requirements

- Node.js 22 or newer
- npm
- OpenCode
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user ID, available from [@userinfobot](https://t.me/userinfobot)

## Run From Source

Clone the fork and install dependencies:

```bash
git clone https://github.com/jexxor/opencode-telegram-bot.git
cd opencode-telegram-bot
npm install
```

Create configuration:

```bash
cp .env.example .env
```

Set at least these values in `.env`:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USER_ID=your-telegram-user-id
OPENCODE_MODEL_PROVIDER=opencode
OPENCODE_MODEL_ID=big-pickle
```

Start OpenCode on the same machine:

```bash
opencode serve
```

The default OpenCode API URL is `http://localhost:4096`. Change
`OPENCODE_API_URL` if needed.

Build the bot and run it:

```bash
npm run build
npx --yes --package . -- opencode-telegram start
```

The command runs in the foreground. Start it again after source changes by
running `npm run build` first. If required configuration is missing, the bot
opens its setup wizard.

## Main Commands

| Command           | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `/status`         | Show server, project, model, and session status    |
| `/new`            | Create a session                                   |
| `/sessions`       | List and switch sessions                           |
| `/abort`          | Abort the current task                             |
| `/detach`         | Stop following a session without stopping its task |
| `/messages`       | Browse messages, revert, or fork                   |
| `/projects`       | Select a project                                   |
| `/worktree`       | Select a git worktree                              |
| `/open`           | Add a project by browsing directories              |
| `/ls`             | Browse project files                               |
| `/settings`       | Change runtime settings                            |
| `/rename`         | Rename the current session                         |
| `/commands`       | Run custom commands                                |
| `/skills`         | Run OpenCode skills                                |
| `/mcps`           | Browse and toggle MCP servers                      |
| `/task`           | Create a scheduled task                            |
| `/tasklist`       | List or delete scheduled tasks                     |
| `/loop`           | Create a repeating multi-session pipeline           |
| `/loops`          | Manage agent loops                                  |
| `/mission`        | Create a nested mission                             |
| `/missions`       | Run and manage missions                             |
| `/opencode_start` | Start a local OpenCode server                      |
| `/opencode_stop`  | Stop a local OpenCode server                       |
| `/help`           | Show available commands                            |

Regular text messages are sent to the selected OpenCode session when no
interactive flow is waiting for input.

Scheduled tasks require an active session. A run waits for its bound session to
become idle, then appends its prompt and result to that existing conversation.

### Agent Loops

Agent loops enqueue one shared prompt across an ordered session sequence. A
session may appear multiple times, the first step starts immediately, and busy
sessions retain their steps in the persistent prompt queue. An optional timeout
stops the loop after N minutes and resets on every Run.

Each run has its own generation. Prompts and terminal responses left over from
an older generation cannot affect a restarted loop. Terminal markers are also
detected in background sessions. Loop prompts ask the assistant to emit
`STOP_LOOP_REASON_TERMINAL` on its own line when all goal work is complete; that
marker stops only the originating generation.

### Missions

Missions are global orchestration objects, not project-owned records. `/mission`
and `/missions` work without a selected project, and one mission may manage root
sessions from multiple projects. Legacy persisted `projectId` fields are ignored.

`/mission` opens a wizard for:

1. Mission name and description.
2. Sub-mission graph construction. The same sub-mission may be added repeatedly
   as independent occurrences.
3. Optional root OpenCode session selection through project -> session menus.
   Selections may include sessions from multiple projects. A mission with
   sub-missions needs no root session of its own.

Missions may also be empty. An empty mission is a valid no-op graph vertex that
can be nested, repeated, edited later, or run without starting any sessions.

Mission shapes have explicit semantics:

- Sub-missions with no root sessions form a logical connector.
- Root sessions with no sub-missions form a working leaf.
- No sub-missions and no root sessions form a no-op placeholder.
- Repeated sub-mission IDs are independent occurrences. Adding the same mission
  three times executes it three times before the parent level can start.

On every full run, mission execution levels are calculated from the leaves:
leaves are level zero and each parent is one level above its deepest child. All
mission occurrences on one level start in parallel. A global barrier prevents
the next parent level from starting until the entire lower level has finished.
Within each mission vertex, explicitly selected root sessions run in parallel.
OpenCode child sessions are controlled by their parent agent and are not
prompted separately by the bot. All actual session prompts share the global
`MISSION_CONCURRENCY_LIMIT` semaphore.

External-directory permission requests from an active mission root or one of
its dynamic child agents are rejected automatically. The requesting session,
not its parent, is aborted and relaunched with instructions to stay inside its
working directory and read `ROLE.md`. Each session gets two retries; another
request disables only that agent and records a failed session run while the
rest of the mission continues. Telegram sends a red notification for every
retry and for the terminal rejection. Sessions outside the active mission tree
keep the normal interactive permission flow.

Before execution starts, the bot asks for one required shared message. The
user-provided text is sent unchanged to every explicitly selected root session
reached through the mission and nested sub-missions.

Run options accept a timeout in whole minutes (`0` means no timeout) and a full
run count (`0` means one run), then asks for the shared message. Pause lets
already active sessions finish but blocks new levels. Resume continues saved
progress. Stop aborts active sessions and ends the run.

`/missions` shows mission structure, root sessions, dynamically created child
agents, live agent status, run/session statistics, timeout, timestamps, and
errors. Child agents remain available for navigation even though the bot does
not execute them separately. The panel also provides Run, Pause/Resume, Stop,
editing for names, descriptions, sub-missions, and root sessions, refresh, and
archiving.
Structural editing is disabled while a mission is running or paused. Archiving
first lists parent missions, then removes every active reference to the archived
mission after confirmation. Mission records are never physically deleted.

The mission panel can also create new root sessions. The user browses a directory
inside `OPEN_BROWSER_ROOTS`, selects it, and enters a swarm size (`0` means the
default single session). Sessions are attached to the mission and named after it:
`Mission`, `Mission 2`, `Mission 3`, and so on. Successfully created sessions are
retained if a later session in the same swarm fails to create.

Mission definitions and statistics persist transactionally in `missions.sqlite`.
Existing mission data is migrated once from `settings.json`. An active or paused
run is marked stopped if the bot restarts; execution is not replayed automatically.

## Configuration

All supported environment variables are documented in `.env.example`. Common
settings include:

- `OPENCODE_API_URL`: OpenCode server URL.
- `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`: optional server auth.
- `BOT_LOCALE`: UI language.
- `SESSIONS_LIST_LIMIT`: number of sessions per page.
- `OPEN_BROWSER_ROOTS`: comma-separated roots available to `/open`; for example,
  `~,/opt` exposes both home and `/opt` while keeping other paths blocked.
- `MISSION_CONCURRENCY_LIMIT`: maximum concurrently executing mission sessions
  across all missions (default: `8`).
- `CODE_FILE_MAX_SIZE_KB`: maximum size of generated code-file attachments.
- `TRACK_BACKGROUND_SESSIONS`: background-session tracking toggle.
- `STT_API_URL` and `STT_API_KEY`: optional voice transcription.
- `TTS_API_URL` and `TTS_API_KEY`: optional audio replies.
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`.

Keep `.env` private. It contains the Telegram bot token.

## Development Checks

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

## License

[MIT](LICENSE)
