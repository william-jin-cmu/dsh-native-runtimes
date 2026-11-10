# dsh-native-runtimes

Native Third-party Runtimes: use the Claude Code, Codex and ACP agents you already have on this machine from inside DeepSeek Harness.

It does two things:

- **Sessions.** Claude Code and Codex appear in the model picker. A session on one of them is run by your own CLI, in the session's folder, and each message continues the same CLI conversation.
- **Threads.** A DSH agent can hand a task to one of these runtimes in the background and follow up on it.

DSH ships its own Claude Code, Codex and ACP subagents. Those run a bundled copy of each runtime for one task and return only the final answer. dsh-native-runtimes is for the other case: it drives **your own** `claude` and `codex` CLIs, with your login, settings and permissions, and keeps each conversation as a **thread** the agent can follow up on and you can inspect.

## Install

Requires DSH `>=0.2.1-rc.5 <0.3.0` and Node.js 22.19 or later. A runtime is offered only if its CLI is found on this machine and you are signed in to it.

```sh
dsh plugin --profile web add ./dsh-native-runtimes-0.1.0.tgz
```

In the desktop app, use Plugins > Add plugin with the path of the tarball instead.

## Sessions

Pick **Claude Code** or **Codex** in a session's model picker and write as usual.

- The runtime brings its own instructions, tools, context and permissions. Of each DSH request only your new message (and attached images) is passed on; DSH's system prompt and tools are not, so DSH tools and skills are not available in these sessions.
- What the runtime does on the way (commands, edits, searches, its thinking) is shown in the turn's process fold; its answer is the reply.
- Switching a running session to one of these models retells the earlier conversation to the runtime once.
- Titles and other one-off requests go to a tool-less one-shot call (Claude Code uses `haiku` for them).
- Permission prompts cannot be answered from DSH: Claude Code runs with `permissionMode`, Codex in its `sandbox`.

## Threads

Ask, for example: "Have Claude Code fix the failing test in this repo, and tell me what it changed."

## Tools for the DSH agent

| Tool | What it does |
|---|---|
| `thread_start` | Hands a task to `claude-code`, `codex` or `acp:<name>` in a directory. Returns a thread id at once; the work runs in the background. |
| `thread_send` | A follow-up on the same thread. The runtime resumes its own session, so it still knows what it did. |
| `thread_list` | Every thread, newest activity first, including ones from earlier DSH sessions. |
| `thread_read` | A thread's task, status and full latest reply; with `activity`, the commands and tool calls of the latest turn. |
| `thread_stop` | Interrupts the running turn and kills what it started. The thread can be continued later. |
| `runtime_usage` | How much of your Claude and Codex subscription quota is used, and when each limit resets. |

When a turn ends, the DSH session that started the thread gets a notice with the reply. An idle agent is woken by it; a busy one sees it at its next step. Replies longer than 4,000 characters are cut in the notice and available in full through `thread_read`.

If `thread_send` reaches a thread that is mid-turn, the message waits and runs next. One message can wait; a second is refused until the thread's next notice.

## How each runtime is driven

- **Claude Code**: `claude -p --output-format stream-json --verbose --permission-mode <mode>`, one process per turn; follow-ups add `--resume <session id>`.
- **Codex**: `codex exec --json --skip-git-repo-check -c sandbox_mode="<mode>"`, one process per turn; follow-ups use `codex exec resume <thread id>`.
- **ACP**: the configured command speaks the Agent Client Protocol on stdio. The process stays alive between turns and is shut down after `acpIdleMinutes`; the next follow-up starts it again and resumes the session if the agent supports `session/resume` or `session/load`. Otherwise it starts a new session and the thread's activity says the earlier context was lost.

Nobody can answer a permission prompt inside a thread. Claude Code runs with `acceptEdits` by default, so file edits go through and anything else that would prompt is denied unless your own Claude settings allow it. Codex runs in its `workspace-write` sandbox. ACP permission requests are allowed by default (`autoApprove`).

## Configuration

Override in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. A patch replaces the whole `config`, so state every key you want to differ from the default.

```yaml
- id: native-runtimes
  name: dsh-native-runtimes
  config:
    sessions: true                 # offer Claude Code and Codex in the model picker
    claude:
      command: ''                  # path to claude; empty searches PATH, ~/.local/bin, /opt/homebrew/bin, ...
      model: ''                    # empty uses the CLI's default
      permissionMode: acceptEdits  # acceptEdits | default | plan | dontAsk | bypassPermissions
      models: [opus, sonnet, haiku]                     # extra picker entries for sessions
      sessionArgs: ['--thinking-display', 'summarized'] # extra claude flags for sessions
    codex:
      command: ''
      model: ''
      sandbox: workspace-write     # workspace-write | read-only | danger-full-access
      models: []
    acp:                           # each entry becomes the runtime acp:<name>
      gemini:
        command: gemini
        args: ['--experimental-acp']
        env: {}
        autoApprove: true
    maxConcurrent: 4               # threads running a turn at the same time
    turnTimeoutMinutes: 60         # a longer turn is stopped and reported as timed out
    acpIdleMinutes: 15             # how long an idle ACP agent process is kept
```

## Where things are kept

`$DSH_HOME/ntr/threads/<id>.json` (`~/.dsh/ntr/threads/` by default): one file per thread with its turns, replies and activity. A thread that was running when DSH stopped is marked `interrupted` on the next start and can be continued with `thread_send`.

`runtime_usage` reads the login each CLI already stores (the Keychain item "Claude Code-credentials" or `~/.claude/.credentials.json`; `~/.codex/auth.json`) and asks the vendor's own usage endpoint through `curl`, so your proxy settings apply. It never refreshes or writes a token.

## Limits

- Threads run unattended: there is no way to answer a runtime's question or approve a single action mid-turn.
- A thread's activity is a list of one-line entries (commands, tool names, files). The runtime's full transcript stays in its own session store (`claude --resume`, `codex resume`).
- Stopping a turn kills the runtime's process group. A command the runtime detached into its own session can outlive it.
- macOS and Linux only. `runtime_usage` reads the Keychain on macOS and the credentials files elsewhere.

## Development

```sh
node scripts/build.mjs dsh-native-runtimes                                  # from the repository root
./node_modules/.bin/tsc --noEmit -p packages/dsh-native-runtimes/tsconfig.json
node --test packages/dsh-native-runtimes/test/*.test.mjs
```

- `src/index.ts`: config, the six tools, completion notices
- `src/threads.ts`: thread lifecycle, the follow-up queue, persistence
- `src/runtimes/`: one driver per runtime, each with a pure stream parser
- `src/usage.ts`: subscription quota
