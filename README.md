# claude-pod

I was spending hours clicking through Claude approvals, and at some point I stopped reading them and just clicked. That is absolutely not recommended.

Then I found a small repo, forked it and adapted it to my needs. Now every session I run locally goes through an orchestrator, but the implementation happens in a closed box: the active agent gets briefed, does everything it thinks is important, and comes back with the result. Then a reviewer does the same, and then I do the human approval.

**Is it 100% safe?** Likely not. **Does it save me headache?** Definitely yes.

![claude-pod](assets/cover.jpeg)

## What it is

A small CLI (command-line interface) that runs Claude Code inside a Docker container that mounts only the project you launch it from, so it can run with `--dangerously-skip-permissions` while your home directory, SSH (Secure Shell) keys and other projects stay invisible to it. The pod is treated as hostile: nothing it writes is trusted by the host afterwards.

Unofficial: not affiliated with or endorsed by Anthropic.

## Install

Requirements: Docker (Desktop, OrbStack, Colima or Engine), Node.js 20+, and a Claude subscription.

```sh
git clone <this repo> && npm install -g ./claude-pod   # links the `claude-pod` command
claude-pod build                                       # build the Docker image
claude setup-token && claude-pod auth                  # create a login token, paste it
claude-pod doctor                                      # check everything
```

## Use

```sh
cd your-project                                        # a git repo
claude-pod claude                                      # interactive Claude in the pod
claude-pod run --model opus --prompt-file /tmp/task.md --out /tmp/task   # headless agent run
```

`claude-pod run` is what an orchestrator calls to hand a task to a sandboxed agent: the prompt goes in on stdin, and the result lands in `/tmp/task.out`, `.err` and `.exit`. Run `claude-pod guide` for a briefing you can give an agent, or `claude-pod --help` for every command.

To wire it into an orchestrator (permissions, Docker network, ports, env), see **[INTEGRATION.md](INTEGRATION.md)**.

## What it does and doesn't protect

- **Protected:** everything outside the project folder, and the host-side files a pod could use to run code on your machine later (`.git/hooks`, `.git/config`, `.claude/`, `.mcp.json`, ...) are read-only or quarantined.
- **Not protected:** the project itself is read-write, so review the diff before running its scripts on your host. Network access is open by default, so a hostile pod could send the project, and its login token, anywhere. `"network": "none"` cuts that, but also takes Claude offline.

Details: [docs/REFERENCE.md](docs/REFERENCE.md#security-model).

## More

- [docs/REFERENCE.md](docs/REFERENCE.md): config file, ports, login, several pods, pinning Claude Code, full security model, uninstall.
- Tests: `npm test` (uses a fake Docker, no daemon needed).

## License

MIT, see [`LICENSE`](LICENSE). Claude Code is a separate product owned by Anthropic, PBC, and is not redistributed here: `claude-pod build` fetches it from npm at build time. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, used nominatively.
