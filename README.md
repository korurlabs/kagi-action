# Kagi Secrets GitHub Action

Load the [Kagi](https://kagi.pw) secret set your organization granted a workflow, using the job's
own identity. There is no token to store, rotate or leak: GitHub mints a short-lived OIDC id-token
for the job, Kagi matches it against the CI binding an org admin configured, and the job receives
exactly the secret set that binding grants.

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

      - uses: korurlabs/kagi-action@<full commit sha> # v2

      - run: ./deploy.sh   # the secret set is now in this step's environment
```

The step needs no inputs. Kagi finds the binding from the job's own claims (repository, workflow,
ref, event, environment), so there is no binding id to copy into the workflow.

Pin the action to a full commit SHA and keep the tag in a comment, as above. A tag can be moved; a
commit cannot, and this action handles your secrets.

## What the action does

1. It downloads the Kagi CLI release this action version pins from
   `github.com/korurlabs/kagi-cli/releases`, for the runner's platform.
2. It checks the archive's SHA-256 against the checksum committed in `src/cli-release.json`, before
   anything is extracted. A mismatch fails the step and nothing from the archive is run.
3. It extracts only the `kagi` binary into `$RUNNER_TEMP` and puts it on `PATH` for the later
   steps of the job.
4. It runs `kagi pull --github-env`. The CLI requests the job's id-token, exchanges it at Kagi for a
   single-use Kagi token, reads the secret set once, masks every value and appends each variable to
   `$GITHUB_ENV`. The Kagi token stays in the CLI's memory and is never written anywhere.
5. At the end of the job, the post step runs `kagi ci revoke`, which revokes the GitHub tokens Kagi
   minted for this job (if the set contains GitHub token items). It runs whether the job succeeded
   or failed, and does nothing when there is nothing to revoke.

Every later step of the job gets the secret set in its environment. Steps in other jobs do not.

The CLI's output is passed through unchanged, and only its exit code decides whether the step
fails. When Kagi refuses the job, the CLI prints the job's claims next to the reason, so an org
admin can see which binding is missing.

## Limiting the secrets to one command

`kagi pull --github-env` hands the set to every later step of the job, including third-party
actions. To give it to one command only, install the CLI without pulling and wrap that command in
`kagi run`:

```yaml
      - uses: korurlabs/kagi-action@<full commit sha> # v2
        with:
          pull: 'false'

      - run: kagi run -- ./deploy.sh   # only ./deploy.sh sees the secrets
```

`kagi run` fetches the set when its step starts, hands it to the command's environment only, and
revokes any GitHub token it minted when the command ends. It reads the same environment variables
as the action: if you set `api-url`, `binding-id` or `audience`, also set `KAGI_API_URL`,
`KAGI_BINDING_ID` or `KAGI_AUDIENCE` in the environment of the step that runs `kagi run`.

Because each fetch happens when its step starts, `kagi run` also suits a GitHub token that is needed
late in a long job: GitHub fixes an installation token's lifetime at one hour from minting.

To write the set to a file instead, set `pull: 'false'` and run `kagi pull --out-file <path>`, which
writes `KEY=VALUE` lines to that file with mode `0600`.

## Inputs

Every input is optional.

| Input | Default | Description |
|---|---|---|
| `binding-id` | none | The id of the Kagi CI binding to evaluate. Leave it unset; it is needed only for a binding that pins its own audience, which Kagi reaches by its id. It is a reference, not a credential. |
| `audience` | the CLI's default, `api.kagi.pw` | Audience of the GitHub id-token. Set it, together with `binding-id`, only for a binding with a custom audience. |
| `api-url` | `https://api.kagi.pw` | Kagi API root. Change it only for a self-hosted Kagi. It must use `https`; plain `http` is accepted only for a server on the runner itself (`localhost`, `127.0.0.1`, `[::1]`). |
| `version` | the pinned version | Kagi CLI version to install. Any version other than the pinned one is refused, because the action has no checksum for it. |
| `pull` | `true` | Run `kagi pull --github-env`. Set it to `false` to only install the CLI, see [Limiting the secrets to one command](#limiting-the-secrets-to-one-command). |

The action has no outputs. Secret values never become step outputs.

If `KAGI_TOKEN` is set in the step's environment, the CLI uses that token instead of the job's
id-token, and warns about it in the job log. Remove `KAGI_TOKEN` to let the binding decide.

## Masking

The CLI registers every value, and each line of a multi-line value, with the runner's log masker
(`::add-mask::`) before it writes the value to `$GITHUB_ENV`. It writes those commands to stderr.
The action starts the CLI with its stdout and stderr inherited, never captured or filtered, so the
commands reach the runner exactly as the CLI wrote them. The runner reads workflow commands from
both output streams of an action's process (actions/runner,
`src/Runner.Worker/Handlers/NodeScriptActionHandler.cs`).

Masking is log hygiene, not a security boundary. Any step of a job with `id-token: write` can
request the job's id-token and fetch its set, and any step after the pull can read the variables.
Run secret-using work in a dedicated job, pin every action to a commit SHA, and prefer `kagi run`
over `--github-env` where you can.

## Requirements

- A Linux or macOS runner on x64 or arm64. On Windows the step fails with a message saying so.
- `permissions: id-token: write`. Without it the runner offers no id-token and the CLI says what to
  add.
- A runner that supports `runs.using: node24` (v2.327.0 or newer). Every GitHub-hosted runner does;
  self-hosted runners may need updating.

## Upgrading from v1

v1 stops working against the current Kagi API: it called `POST /kagi/auth/ci/fetch`, which Kagi
replaced with a token exchange and a single-use read of the job's secret set. Move to v2:

- Remove `binding-id` unless the binding pins a custom audience.
- Remove `export-env`, `env-file-path`, `request-timeout-seconds` and `mask`; v2 does not have them.
  For a file, use `kagi pull --out-file` as shown above.
- Remove any use of the outputs `secret-count`, `scope-count` and `env-file`; v2 has no outputs.
- In Kagi, give the workflow's binding a secret set. A binding grants one set, not a list of
  (app, environment) scopes.

## The pinned CLI

`src/cli-release.json` holds the Kagi CLI version this release installs and the SHA-256 of each of
its four archives. The hashes are committed with the action, so pinning the action to a commit also
pins the exact CLI binary it runs.

To move to another CLI release:

```bash
scripts/pin-cli.sh <version>   # for example: scripts/pin-cli.sh 0.31.1
```

The script downloads the release's checksums file and each archive, checks that both agree, and
rewrites `src/cli-release.json`. Review the diff and commit it.

## Versioning

| Reference | Meaning |
|---|---|
| `@<full commit sha> # v2` | Exact commit. Immutable. Recommended. |
| `@v2.0.0` | Exact release tag. |
| `@v2` | Floating major tag, moved to each new `v2.x.y` release. |

Breaking changes only ship in a new major version, and the floating major tag is never moved onto
a prerelease.

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
