# Kagi Secrets GitHub Action

Load the [Kagi](https://kagi.pw) secrets of an app environment into a GitHub Actions job, using the
job's own identity. There is no token to store, rotate or leak: GitHub mints a short-lived OIDC
id-token for the job, Kagi checks it against the workload roles an org admin created, and the job
receives the secrets of the one app environment it asked for, only when a role grants it.

## Set up a workload role in Kagi

An org admin does this once per workflow, in the Kagi portal:

1. Open **Integrations** and connect **GitHub Actions** (or open the connection if it exists).
2. Under **Access**, choose **Add access**, then **New role**.
3. Give the role a **Name** (lowercase letters, digits and dashes).
4. Under **Environments**, choose **Add environment**, then the **App** and the **Environment** the
   workflow reads. Add one row per app environment.
5. Choose **Next** and say which runs get the role:
   - **Repositories**: the repositories whose workflows get the role.
   - **Branch or tag**: optional, written in full, such as `refs/heads/main`. Globs are allowed.
   - **GitHub environment**: optional; only jobs that run in this GitHub deployment environment.
   - **Workflow**: optional; the workflow file as a path in the repository, without the
     `owner/repo/` prefix, such as `.github/workflows/deploy.yml@refs/heads/main`. Globs are
     allowed.
   - **Require a protected branch or tag**: only runs on a ref with branch or tag protection.
   - **Allow pull requests**: off by default, because a pull request can run code from a fork.
     Leave it off unless the workflow must read secrets on pull requests.
6. Choose **Create role**.

Even when every condition matches, Kagi refuses by default a run on a self-hosted runner and a run
started by an event other than `push`, `workflow_dispatch`, `release` or `schedule` (or a pull
request, when **Allow pull requests** is on).

The workflow then needs the app's id and the environment's slug. The app id is the `app-id` that
`kagi setup` writes into a `kagi.yaml`; it is a reference, not a credential.

## Quick start

```yaml
permissions:
  id-token: write   # lets GitHub mint the job's id-token
  contents: read    # naming one permission sets every other one to none

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: korurlabs/kagi-action@v0.1.0
        with:
          app-id: 6d8f6d80-4e21-469d-907d-b13773f4e284
          environment: production

      - run: ./deploy.sh   # the app environment's secrets are now in this step's environment
```

For production, pin the action to a full commit SHA and keep its release tag in a comment
(`korurlabs/kagi-action@<full commit sha> # v0.1.0`). This action handles your secrets, and a commit
SHA names exactly one tree of code. See [Versioning](#versioning).

## What the action does

1. It downloads the Kagi CLI release this action version pins from
   `github.com/korurlabs/kagi-cli/releases`, for the runner's platform.
2. It checks the archive's SHA-256 against the checksum committed in `src/cli-release.json`, before
   anything is extracted. A mismatch fails the step and nothing from the archive is run.
3. It extracts only the `kagi` binary into `$RUNNER_TEMP` and puts it on `PATH` for the later
   steps of the job.
4. It runs `kagi pull --github-env --identity github --app-id <app-id> --env <environment>`. The
   CLI requests the job's id-token, exchanges it at Kagi for a short-lived Kagi token that reads
   only that app environment, reads its secrets, masks every value and appends each variable to
   `$GITHUB_ENV`. The Kagi token stays in the CLI's memory and is never written anywhere.
5. At the end of the job, the post step runs `kagi ci revoke`. It revokes the GitHub tokens a
   [legacy CI binding](#legacy-ci-bindings) had Kagi mint for the job, and does nothing when there
   are none. It runs whether the job succeeded or failed.

Every later step of the job gets these secrets in its environment. Steps in other jobs do not.

The CLI's output is passed through unchanged, and only its exit code decides whether the step
fails. When no role grants the job, the CLI names the app and environment it asked for, and the
denial is listed on the GitHub Actions connection under **Integrations** in the portal, with the
claims of the run, so an org admin can see which condition did not match.

## Limiting the secrets to one command

`kagi pull --github-env` hands the secrets to every later step of the job, including third-party
actions. To give them to one command only, install the CLI without pulling and wrap that command
in `kagi run`. Nothing is written to disk or to `$GITHUB_ENV`:

```yaml
      - uses: korurlabs/kagi-action@v0.1.0
        with:
          pull: 'false'

      - run: >-
          kagi run --identity github
          --app-id 6d8f6d80-4e21-469d-907d-b13773f4e284 --env production
          -- ./deploy.sh
        # only ./deploy.sh sees the secrets
```

`kagi run` exchanges the job's id-token when its step starts, hands the secrets to the command's
environment only, and forgets them when the command ends. The CLI reads the app and environment
only from its flags or from a `kagi.yaml` in the working directory, never from an environment
variable, so pass `--app-id` and `--env` in every `kagi run`. `--identity github` makes it use the
job's id-token and fail when the job has none, instead of trying another credential.

`kagi run` reads the other settings from the environment, not from the action's inputs: if you set
`api-url` or `audience`, also set `KAGI_API_URL` or `KAGI_AUDIENCE` in the environment of the step
that runs `kagi run`.

To write the secrets to a file instead, run
`kagi pull --identity github --app-id <id> --env <slug> --out-file <path>`, which writes
`KEY=VALUE` lines to that file with mode `0600`.

## Inputs

No input is marked required in `action.yml`. The action itself refuses a pull without `app-id` and
`environment` (or a legacy `binding-id`), before anything is downloaded.

| Input | Default | Description |
|---|---|---|
| `app-id` | none | The id (a UUID) of the Kagi app whose secrets the job reads. Required with `environment` when the action pulls, unless `binding-id` is set. |
| `environment` | none | The slug of the app environment to read, such as `production`. Required with `app-id` when the action pulls, unless `binding-id` is set. |
| `pull` | `true` | Run `kagi pull --github-env`. Set it to `false` to only install the CLI, see [Limiting the secrets to one command](#limiting-the-secrets-to-one-command). With `false`, `app-id` and `environment` may be left unset. |
| `api-url` | `https://api.kagi.pw` | Kagi API root. Change it only for a self-hosted Kagi. It must use `https`; plain `http` is accepted only for a server on the runner itself (`localhost`, `127.0.0.1`, `[::1]`). |
| `audience` | the host of `api-url` (`api.kagi.pw` by default) | Audience of the GitHub id-token. Set it only when your Kagi deployment expects another one. |
| `version` | the pinned version | Kagi CLI version to install. Any version other than the pinned one is refused, because the action has no checksum for it. |
| `binding-id` | none | Legacy. The id of a Kagi CI binding, see [Legacy CI bindings](#legacy-ci-bindings). Cannot be combined with `app-id` or `environment`. |

The action has no outputs. Secret values never become step outputs.

If `KAGI_TOKEN` is set in the step's environment, the CLI uses that token instead of the job's
id-token, and warns about it in the job log. Remove `KAGI_TOKEN` to let the workload roles decide.

## Legacy CI bindings

Before workload roles, Kagi matched a job against a CI binding, which decided by itself which
secrets the job received. New CI bindings can no longer be created; the portal lists the remaining
ones under the GitHub Actions connection only so they can be deleted. A job that still uses one
keeps working with `binding-id`:

```yaml
      - uses: korurlabs/kagi-action@v0.1.0
        with:
          binding-id: 3fa2c1e0-0000-4000-8000-000000000000
```

With `binding-id`, the action runs `kagi pull --github-env` with the binding id in
`KAGI_BINDING_ID`, and the binding decides what the job gets, GitHub tokens included. For
`kagi run`, set `KAGI_BINDING_ID` in the step's environment and pass no `--app-id` or `--env`.

Without `binding-id`, the action removes any `KAGI_BINDING_ID` from the CLI's environment and warns
about it, so a value left in the workflow cannot turn a role read into a binding read.

To move a job to a workload role, create the role as in
[Set up a workload role in Kagi](#set-up-a-workload-role-in-kagi), replace `binding-id` with
`app-id` and `environment`, and delete the binding once the job reads through the role.

## Masking

The CLI registers every value, and each line of a multi-line value, with the runner's log masker
(`::add-mask::`) before it writes the value to `$GITHUB_ENV`. It writes those commands to stderr.
The action starts the CLI with its stdout and stderr inherited, never captured or filtered, so the
commands reach the runner exactly as the CLI wrote them. The runner reads workflow commands from
both output streams of an action's process (actions/runner,
`src/Runner.Worker/Handlers/NodeScriptActionHandler.cs`).

Masking is log hygiene, not a security boundary. Any step of a job with `id-token: write` can
request the job's id-token and read what the job's roles grant, and any step after the pull can
read the variables. Run secret-using work in a dedicated job, pin every action to a commit SHA, and
prefer `kagi run` over `--github-env` where you can.

## Requirements

- A Linux or macOS runner on x64 or arm64. On Windows the step fails with a message saying so.
- `permissions: id-token: write`. Without it the runner offers no id-token and the CLI says what to
  add.
- A runner that supports `runs.using: node24` (v2.327.0 or newer). Every GitHub-hosted runner does;
  self-hosted runners may need updating.

## The pinned CLI

`src/cli-release.json` holds the Kagi CLI version this release installs and the SHA-256 of each of
its four archives. The hashes are committed with the action, so pinning the action to a commit also
pins the exact CLI binary it runs.

To move to another CLI release:

```bash
scripts/pin-cli.sh <version>   # for example: scripts/pin-cli.sh 0.33.0
```

The script downloads the release's checksums file and each archive, and reads the SHA-256 digest
GitHub records for each of them from the releases API. It rewrites `src/cli-release.json` only when,
for every archive, the checksums file, GitHub's digest and the downloaded bytes agree, and it refuses
when GitHub has no digest for an archive. It needs the GitHub CLI (`gh`), signed in. Review the diff
and commit it.

## Versioning

The action is pre-1.0. A minor release (`0.x`) may break a workflow, so pin an exact version
(`@v0.1.0`) or, better, a full commit SHA with the version in a comment. There is no moving `v0`
tag. This repository never moves a release tag; a fix ships as a new `v0.x.y` tag, and a workflow
gets it by changing its pin.

The tags `v1`, `v2` and `v3` (and their releases) were early tags and are withdrawn. Do not pin them.

Dependabot with `package-ecosystem: github-actions` opens a pull request for a pinned action when
a new release ships, and it updates the version comment next to a SHA.

A release is only cut from a commit on `main`; the release workflow refuses a tag on any other
commit.

## Development

```bash
npm test                            # node --test, no install step
KAGI_ACTION_NETWORK=1 npm test      # also downloads the pinned CLI from GitHub and runs it
```

The action has no dependencies, no build and no `dist/`: `src/` is exactly what runs on the runner.
The tests need Node 22 or newer, for the glob in the test script.

`.github/workflows/ci.yml` runs the action itself on Linux and macOS runners against
`test/e2e-server.js`, a stand-in for GitHub's token service and the Kagi API.

## License

MIT, see [LICENSE](LICENSE).
