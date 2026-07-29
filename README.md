# branchdeck

**Run every git branch as its own live app, from one clone.**

<!-- badges: npm version · CI · license — add once published -->

You have three AI agents working at once. Each one pushes to its own branch.
Now you want to actually look at what they built — click through the running
app, not read a diff.

Normally that means checking out one branch at a time and restarting your dev
server on every switch, or keeping three separate clones and paying for three
separate `npm install`s. branchdeck does neither. It builds and runs each
branch as a live app on its own port, all from the clone you already have:

```
agent/pricing-rewrite   →  http://localhost:8101
agent/search-fixes      →  http://localhost:8102
agent/new-onboarding    →  http://localhost:8103
```

Three tabs, three running apps. When an agent pushes, branchdeck rebuilds only
what changed, and the tab in front of you can refresh itself.

![The branchdeck control pane](docs/control-pane.png)

## What you get

- **A live app per branch**, built from what was actually pushed to `origin`.
- **One clone.** Branches sit side by side as git *worktrees* — extra working
  folders that git manages for you, sharing your clone's history.
- **Shared dependency installs.** The tenth preview costs megabytes, not
  another `node_modules`.
- **Safe automatic updates.** `branchdeck watch` checks for new commits, then
  rebuilds and restarts only the branches that actually moved.
- **Auto-reload.** Open tabs refresh when their preview is rebuilt.
- **A browser control pane**, if you'd rather click than type.
- **No Docker, no cloud, no background service.** Ordinary processes on your
  machine that stop when you tell them to.
- Zero dependencies of its own. Windows, macOS and Linux, all tested in CI.

## Requirements

| | |
| --- | --- |
| [Node.js](https://nodejs.org) 18+ | branchdeck is a Node program |
| git | it drives git directly |
| Python | only if your project uses it |

## Install

branchdeck isn't on npm yet. Install it from source:

```bash
git clone https://github.com/mhumphries-wlu/BranchDeck.git
cd BranchDeck
npm link
```

`npm link` makes the `branchdeck` command available everywhere, pointing at
this clone — so `git pull` here is all it takes to update later. If you'd
rather not touch your PATH, skip `npm link` and run
`node path/to/BranchDeck/src/cli.mjs` instead.

Check it worked:

```bash
branchdeck version
```
```
0.3.0
```

Once branchdeck is published this becomes `npm install -g branchdeck`.

## Set up your project

Go to your repository and let branchdeck look at it:

```bash
cd path/to/your/repo
branchdeck init
```

```
[branchdeck] detected: Vite application
[branchdeck] wrote preview.config.json

Review it before your first `add` — in particular:
  - previews serve the production build via `vite preview`

Then:  branchdeck add <branch>
```

That writes `preview.config.json`, which tells branchdeck how to install,
build, and start your app. Open it and check the start command — that's the
one thing worth getting right before you continue. The notes printed in your
terminal point at whatever branchdeck had to guess.

Commit the file if you want previews to work the same for everyone. If you'd
rather keep it to yourself, add it to `.git/info/exclude`, which ignores files
for your clone only and never gets committed. Both work.

## Everyday use

**Add a branch.** This creates its worktree, installs dependencies, builds,
and starts the app:

```bash
branchdeck add agent/pricing-rewrite
```

```
[branchdeck] creating worktree for agent/pricing-rewrite at ../myrepo-previews/wt/agent-pricing-rewrite ...
[branchdeck]   [agent/pricing-rewrite] installing pool node/9f2c1a3b7e21 — once for every branch with these manifests
...npm output streams here...
[branchdeck]   [agent/pricing-rewrite] building frontend ...
[branchdeck]   [agent/pricing-rewrite] ready -> http://localhost:8101
```

The first one is slow. It's a real install and a real build, and you'll see
every line of it as it happens.

**Add another.** If it needs the same dependencies, this one skips the install
entirely:

```bash
branchdeck add agent/search-fixes
```

```
[branchdeck]   [agent/search-fixes] using shared pool node/9f2c1a3b7e21 (no install needed)
[branchdeck]   [agent/search-fixes] building frontend ...
[branchdeck]   [agent/search-fixes] ready -> http://localhost:8102
```

**Open them:**

```bash
branchdeck open
```

**Keep them up to date** while your agent pushes:

```bash
branchdeck watch                             # every preview
branchdeck watch claude/fix-login-4a2f9c     # one branch
```

`watch` fetches the remote commit id on an interval, but compares it with the
commit already running **before** it considers process health or calls the
restart path. No new commit means no rebuild and no restart. When a branch
moves, BranchDeck updates that worktree, rebuilds only what changed, restarts
on the same ports, and the open tab reloads after the app is ready.

The default interval is 60 seconds. Override it for one run with
`--interval <seconds>`, or set `watchIntervalSeconds` in the machine-local
settings file. `Ctrl+C` stops watching but leaves the previews running. Watch
holds BranchDeck's repository lock, so stop it before issuing another CLI
command.

For a manual update instead:

```bash
branchdeck refresh                          # every preview
branchdeck refresh claude/fix-login-4a2f9c  # one branch
branchdeck refresh --port 8101              # whichever branch is on that port
```

A refresh fetches from `origin`. If the branch hasn't moved and its servers
are still up, branchdeck says `already up to date and running` and leaves them
alone. If it *has* moved, the worktree is updated, only the build steps whose
inputs changed re-run, and the servers restart on the same ports. Tabs you
opened from branchdeck reload themselves once the app is back.

For schedulers and diagnostics, `branchdeck watch --once` performs one safe
commit check and exits.

## The browser control pane

```bash
branchdeck ui
```

Everything the CLI does, as a web page: pick a branch from a dropdown to add
it, control each preview with Open / Refresh / Restart / Stop / Remove, follow
a live activity feed, and flip between named consoles for each running server.
There's a config editor too, which validates before it saves, so a stray comma
can't quietly break every preview.

**Refresh all**, at the top of the previews list, is the button version of
`branchdeck refresh`; each preview has its own **Refresh** for one branch at a
time.

It opens on port 8100 by default — `--port` to change that, `--no-open` to
skip launching the browser.

![The configuration pane](docs/configuration.png)

The page is bound to `127.0.0.1`, so nothing outside your machine can reach
it. Every request also needs a token, generated fresh each time the server
starts and included in the URL it prints. That matters because this page can
start processes your config defines. Treat the printed URL like a password.

## Why it doesn't eat your disk

Run four branches the obvious way and you install dependencies four times. For
a project with a few hundred megabytes of `node_modules`, that's gigabytes of
near-identical files, and it gets worse with every branch an agent creates.

The tempting shortcut — share one `node_modules` between all of them — is
actively dangerous. The moment two branches disagree about a dependency, one
of them silently runs against the other's packages. You get a bug that makes
no sense, because it isn't really a bug in your code.

branchdeck shares installs by **content**. Each shared install lives in a
folder named after a hash of the files that defined it — your
`package-lock.json`, your `requirements.txt`:

```
myrepo-previews/pool/node/9f2c1a3b7e21/node_modules
myrepo-previews/pool/py/3ab77e19f402/venv
```

Two branches with byte-for-byte identical dependency files produce the same
folder name, so they share one install automatically. Change a dependency on
one branch and it produces a different name, so it gets its own install, built
fresh, leaving everyone else alone. Revert that change and it rejoins the
shared one. Nothing to configure, and no way to end up running against the
wrong packages — the folder name *is* the guarantee.

Ten branches on the same lockfile cost about one install. Branches that
genuinely differ cost exactly what they should.

## Auto-reload

`refresh` keeps the *app* current. Auto-reload keeps the *tab* current, so you
don't have to hit F5 after every refresh.

Add a `reload` block to your config and branchdeck writes two small files into
your build output on every refresh — a revision marker and a watcher script — and
adds a `<script>` tag to your built HTML pointing at the watcher. The page
checks the marker every few seconds and reloads when it changes. Same idea as
LiveReload, without putting a proxy in front of your app.

```jsonc
"reload": {
  "injectInto": ["dist/index.html"],
  "intervalSeconds": 3
}
```

This works for any tab, however you opened it — `branchdeck open`, a bookmark,
a URL you typed by hand. It also re-checks whenever you click back into the
tab, so returning to a preview you left open shows current code straight away.

The watcher is a separate file rather than inline code on purpose. Apps that
send a `Content-Security-Policy: script-src 'self'` header silently discard
inline scripts, and this way auto-reload keeps working on them.

Two limits. It needs a static HTML file to inject into, so server-rendered
apps like Next.js in production mode can't use it. And you can turn it off
globally with `"autoReload": false` in settings, or for one project by
removing the block.

## Seeing what your servers print

Servers run in the background — no console window per branch, nothing you can
close by accident and kill your app.

```bash
branchdeck logs agent/pricing-rewrite web --follow
```

Name the service (`web` here) to see what that **server** is printing. Without
a service name you get the install and build output instead, which is what you
want when a preview failed to start rather than when it's running.

```bash
branchdeck consoles
```

On Windows this opens one terminal tab per running server, each titled like
`Backend — agent/pricing-rewrite`. Tabs need [Windows
Terminal](https://aka.ms/terminal); without it you get separate titled
windows. On macOS and Linux it prints the `tail -f` command for each server,
since terminals there have no common "open a tab" command.

Those tabs only follow a log file, so closing one never stops the server.

The control pane shows the same consoles as clickable tabs, which is usually
easier.

## Commands

| | |
| --- | --- |
| `branchdeck init [--force]` | Detect your stack, write `preview.config.json` |
| `branchdeck add <branch>` | Create a preview and start it |
| `branchdeck refresh` | Fetch every preview, rebuild what changed, restart |
| `branchdeck refresh <branch>` | Same, for one branch |
| `branchdeck refresh --port <n>` | Same, for whichever branch is on that port |
| `branchdeck watch [<branch>] [--interval N]` | Auto-refresh only after new commits |
| `branchdeck open [<branch>]` | Open browser tabs |
| `branchdeck status [--offline]` | Ports, running services, commit, sharing |
| `branchdeck stop [<branch>\|--all]` | Stop a preview's servers |
| `branchdeck restart [<branch>]` | Rebuild if needed and restart |
| `branchdeck logs <branch> [service] [--follow]` | Show or stream a log |
| `branchdeck consoles [<branch>]` | Terminal tab per running server |
| `branchdeck remove <branch>` | Delete a preview (shared installs are kept) |
| `branchdeck gc` | Delete shared installs nothing uses anymore |
| `branchdeck ui [--port N] [--no-open]` | Browser control pane |
| `branchdeck help` · `branchdeck version` | Work from anywhere |

`rm` is shorthand for `remove`, `-f` for `--follow`, and `--verbose` on
anything adds detail. Every command except `help` and `version` has to run
inside your repository.

## Configuration

`preview.config.json` has four parts. `branchdeck init` fills them in for you;
here's what they mean when you want to change something.

**`pools`** — dependency installs, shared between branches that need the same
ones:

```jsonc
"pools": [
  {
    "id": "node",
    "manifests": ["package-lock.json", "package.json"],
    "install": "npm ci",
    "link": { "node_modules": "${POOL}/node_modules" }
  }
]
```

`manifests` are the files whose contents decide whether two branches can
share. `link` puts the result where your build expects it — a junction on
Windows, so no administrator rights needed. `link` is optional: a Python
virtualenv, for instance, usually stays in the pool and gets referenced by
path instead.

**`build`** — steps that re-run only when they need to:

```jsonc
"build": [
  { "name": "build", "run": "npm run build", "when": ["src"], "output": "dist" }
]
```

A step runs the first time a preview is built, whenever its `output` is
missing, and after
that only when a commit touches something under `when`. Leave `when` out and
it runs on every new commit. Steps also take `cwd` and `env`.

**`services`** — the processes to run, one port each:

```jsonc
"services": [
  {
    "id": "web",
    "label": "Frontend",
    "run": "node server.js",
    "env": { "API_URL": "http://localhost:${PORT:api}" },
    "health": { "path": "/healthz" },
    "open": true
  }
]
```

`label` names the console tab (`Frontend — my-branch`). `health` is optional;
by default branchdeck waits for the port to accept a connection, which needs
no cooperation from your app. `open` picks which service `branchdeck open`
opens. `cwd` works here too.

**`envFiles`** — copies an env file from your clone into each preview and adds
preview-specific values:

```jsonc
"envFiles": [
  {
    "path": ".env",
    "copyFrom": [".env"],
    "set": { "DB_NAME": "preview_${SLOT}" },
    "appendToCsv": { "ALLOWED_ORIGINS": ["http://localhost:${PORT:web}"] }
  }
]
```

`appendToCsv` is for comma-separated settings like allowed origins — it adds
this preview's address to what's already there instead of replacing it. The
`DB_NAME` line is how you give each preview its own database, so agents'
branches don't collide over shared data.

### Placeholders

| | |
| --- | --- |
| `${PORT}` | this service's port (also set as the `PORT` environment variable) |
| `${PORT:id}` | another service's port |
| `${POOL}` · `${POOL:id}` | a pool's folder |
| `${WORKTREE}` · `${REPO}` · `${DECK}` | this preview's folder, your clone, the state folder |
| `${BRANCH}` | the branch name |
| `${SLOT}` | the branch name made safe for filenames |
| `${MANIFEST}` | the pool's first manifest file |
| `${BIN}` | `Scripts` on Windows, `bin` elsewhere |

These expand in commands (`install`, `run`), in `env` blocks, in `link`
targets, and in `envFiles` values. They don't expand in path-shaped settings
like `cwd`, `output`, `when` or `manifests` — those are used exactly as
written.

<details>
<summary><strong>Stacks <code>init</code> recognises</strong></summary>

| Stack | What it sets up |
| --- | --- |
| Next.js | `next build`, then `next start` |
| Vite | build, then `vite preview` |
| Create React App | build, then serve it with `npx serve` |
| Django | migrate, then `manage.py runserver` |
| Python | virtualenv, with a TODO for your start command |
| Node | `npm start` |
| Python API serving a built frontend | one process for both |
| Anything else | a commented template with TODOs, rather than a guess |

</details>

## Things to know

- **Your config runs shell commands**, the same way an `npm run` script does.
  If a pull request changes `preview.config.json`, read it before you preview
  that branch.
- **Previews share whatever your app connects to** — usually one local
  database — until you separate them. The `${SLOT}` example above is how.
- **A preview shows what was pushed.** If an agent hasn't pushed yet, there's
  nothing for branchdeck to see.
- **Don't edit files inside a preview's folder.** Every refresh resets it to
  match `origin` exactly, and your changes go with it. The generated env file
  is rewritten each refresh too — edit the one in your clone instead.
- **The first `add` is slow**, and it needs whatever your app needs: a real
  `.env`, a database that's running. branchdeck runs your app; it can't
  substitute for its requirements.
- **`remove` keeps shared installs**, which is what makes re-adding a branch
  fast. `gc` deletes the ones nothing references anymore.
- Branch names can contain letters, digits, dots, dashes and slashes. Anything
  else is refused.

## Troubleshooting

**`not inside a git repository`** — `cd` into your clone first. Only `help`
and `version` work from anywhere else.

**`python -m venv` fails** — the `python` on your PATH probably isn't a real
Python. The Microsoft Store placeholder and some conda setups both do this.
Point the pool's `install` at a specific interpreter instead:
`py -3.11 -m venv "${POOL}/venv"`.

**Nothing seems to be happening after `add`** — it's installing or building,
and the output is streaming to your terminal. Don't press `Ctrl+C`. An
interrupted install gets detected and redone next time, but you'll wait
through it twice.

**A preview never becomes ready** — branchdeck gives up after three minutes.
Run `branchdeck logs <branch> <service>` to see your app's own startup error;
a missing environment variable or a database that isn't running are the usual
causes. Without the service name you'll get build output instead.

**A login or form gets rejected on a preview** — your app doesn't trust
`localhost:8101` as an origin yet. Add it with `appendToCsv` in `envFiles`.

**`another branchdeck command is running`** — branchdeck runs one command at a
time per repository, so a long `add` or `refresh` in another terminal (or in
the control pane) will hold the lock until it finishes. Wait for it. If
nothing is really running, delete `<repo>-previews/.lock`.

**Port already in use** — `branchdeck restart <branch>` stops its own process
and waits for the port. If something unrelated owns that port, branchdeck
won't kill it: close that program yourself, or `remove` and re-`add` the
preview to get a different port.

**Your changes to branchdeck aren't taking effect** — you're probably running
an older copy installed some other way. `npm uninstall -g branchdeck`, then
`npm link` again from your clone.

<details>
<summary><strong>How it works</strong></summary>

Everything here is built on things git and your operating system already do.

**Worktrees.** Each branch gets a [`git
worktree`](https://git-scm.com/docs/git-worktree) — a second working folder
sharing your clone's history and objects, so nothing is duplicated except
files that actually differ. Each one is pinned directly to `origin/<branch>`.

**Pools.** Shared installs live outside every worktree, named by a hash of the
files that produced them, and linked or referenced from there.

**Ports.** Each service takes the next free port from 8101, confirmed free by
actually binding it first.

**State.** All of it sits in a folder beside your clone, never inside it:

```
myrepo/                        your clone
myrepo-previews/
  wt/<slot>/                   one folder per preview (feat/one → feat-one)
  pool/<id>/<hash>/            shared installs
  logs/<slot>.log              install and build output
  logs/<slot>.<service>.log    one console per server
  state.json                   previews, ports, the commit each one is on
  settings.json                basePort, browser, watchIntervalSeconds,
                               autoReload, autoReloadTabs, env, uiPort
  .lock                        held while a command runs
```

`preview.config.json` is the only file branchdeck puts in your repository, and
only because that's where it belongs. `git status` stays clean otherwise.

</details>

## Uninstalling

```bash
branchdeck remove <branch>     # for each preview — this is what frees the installs
branchdeck gc
rm -rf ../myrepo-previews
git worktree prune             # only needed if you deleted the folder by hand
npm uninstall -g branchdeck
```

On Windows, use `Remove-Item -Recurse -Force ..\myrepo-previews` for the third
line.

## Prior art

[`git worktree`](https://git-scm.com/docs/git-worktree) is the foundation.
[Portree](https://github.com/fairy-pitta/portree) runs dev servers for
worktrees you create yourself. [pnpm](https://pnpm.io/git-worktrees) solves
dependency duplication for Node projects that adopt it. branchdeck's
contribution is putting branch provisioning, per-branch servers, and
dependency sharing that can't silently give you the wrong packages into one
tool that doesn't care what your stack is.

## License

MIT
