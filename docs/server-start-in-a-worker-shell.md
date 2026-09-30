# Starting a server from a worker shell, measured

`packages/daemon/prompts/worker.md` tells a worker to start a server with PowerShell's
`Start-Process ... -RedirectStandardOutput ... -RedirectStandardError ... -WindowStyle Hidden -PassThru`.
Two measurements bracket that recipe. Neither replaces it, so the recipe is unchanged.

## What was already known (2026-09-18, task overseer-e2jf)

Driving `opencode run --format json` with the adapter's own `OPENCODE_PERMISSION`, one command shape per run:

| Command | Result |
|---|---|
| `pnpm dev` | exit 0 after 79.6 s; the shell tool's timeout ends it at 60 s and kills the server with it |
| `pnpm dev > out 2>&1 & sleep 3; echo started` | exit 0 after 20.6 s |
| `pnpm dev & sleep 3; echo started` | exit 0 after 22.3 s |
| a dev server spawning a stdio-inheriting detached grandchild | exit 0 after 141.8 s on the 120 s timeout |
| `Start-Process pnpm.cmd -ArgumentList 'dev' -RedirectStandardOutput ... -RedirectStandardError ... -WindowStyle Hidden -PassThru` | HANGS; killed at 300 s, and again at 240 s on a repeat |

So the recipe the prompt prescribes is the one shape that hangs, and the backgrounded shape returns.

## What this task measured (2026-09-18, task overseer-0q6m)

The open question was whether the backgrounded shape leaves a server that is usable. It does not.

Two live `opencode run` sessions (opencode 1.18.19, `deepseek/deepseek-flash`, `--variant low`, the adapter's
`OPENCODE_PERMISSION`), in a `git worktree add` checkout of a one-commit temp repo holding a `node:http` server on
port 5217, each making three shell calls: the backgrounded start, a port test, an HTTP request. Both sessions exited 0
in 37 s. Both produced the same three outputs:

1. `node server.js > server.log 2>&1 & sleep 3; echo started` — a PowerShell job table (`Job1 BackgroundJob Running`) and `started`
2. `(Test-NetConnection -ComputerName 127.0.0.1 -Port 5217 ...).TcpTestSucceeded` — `False`
3. `(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5217/).Content` — `No connection could be made because the target machine actively refused it.`

`server.log` held `listening on 5217`, so the server did start and did bind.

The mechanism, reproduced outside opencode by running the same command in a child `pwsh -NoProfile -Command` and
testing the port on both sides of its exit: the port is `True` inside that shell and `False` once the shell exits.
opencode's shell tool on Windows is PowerShell, where `&` is the job operator, not a POSIX background fork. A
background job runs in a child runspace process that the PowerShell host kills when it exits, and every shell tool call
is its own host. So the shape returns quickly precisely because nothing survives it.

## Conclusion

On PowerShell the two properties are exclusive: a start that survives the shell call needs a detached process
(`Start-Process`), which is what hangs opencode's shell tool, and a start that does not hang leaves no server. The
recipe is not replaceable by the backgrounded shape, and a fallback is separate work.
