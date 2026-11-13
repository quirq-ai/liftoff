# Liftoff

A local deploy console for XO Launchpad docker apps. It stores each app's push password encrypted on your computer and runs the whole sequence for you: login, build, push, then a check that the registry really holds the image you pushed. Every deploy is kept in a history with its output.

It needs Node 20.12 or newer and Docker. There is nothing to install: no dependencies, no build step.

## Start

```sh
node bin/liftoff.js serve --open
```

Then open [http://localhost:5438](http://localhost:5438). On Windows `liftoff.cmd serve --open` does the same. The page is served to this computer only.

To add an app, paste the three commands Launchpad shows for it:

```sh
docker login registry.xo.builders -u xo-my-app-xo-abc123+push
docker build --platform linux/amd64 -t registry.xo.builders/my-app-xo-abc123/app:latest .
docker push registry.xo.builders/my-app-xo-abc123/app:latest
```

Liftoff reads the registry, username, image and platform from them. Add the push password and the folder that holds the Dockerfile, and press **Deploy**.

## From a terminal or a script

```sh
node bin/liftoff.js list                       # apps and their last deploy
node bin/liftoff.js deploy my-app              # login, build, push, verify; exit code 0 only when it worked
node bin/liftoff.js deploy my-app --no-cache
node bin/liftoff.js deploy my-app --src D:\other\folder   # switch the app to this source folder, then deploy from it
node bin/liftoff.js queue                      # the queue file's entries with their status
node bin/liftoff.js queue-file D:\projects\queue.json   # move the queue file
node bin/liftoff.js watch                      # deploy new queue entries without the page
node bin/liftoff.js history my-app
node bin/liftoff.js logs my-app 12             # output of deploy #12
node bin/liftoff.js check my-app               # try the stored password against the registry
node bin/liftoff.js set-password my-app        # typed hidden; or pipe it in with --stdin
node bin/liftoff.js add --dir D:\projects\my-app --commands launchpad-commands.txt
```

`my-app` can be the app's number, its id, its name, or the start of its id. The page and the terminal share the same data, so a deploy started in a terminal shows up live in the page, and can be cancelled from either.

`--src` changes the app's source folder and keeps it: later deploys without `--src` use the new folder too. The folder must exist, otherwise nothing is changed and nothing is queued. In the page, the same setting is **Change folder** on the Source card.

## The queue file

The queue is a JSON file you can edit by hand. To deploy, add an entry to the end of the list and save:

```json
[
  { "app": 1, "src": "my-project" }
]
```

| Field | Meaning |
| --- | --- |
| `app` | The app's number. Every app gets one when it is added; it never changes and is shown before the app's name in the page and in `liftoff list`. The app's id works too. Optional when `src` is given: see below. |
| `src` | The source folder, relative to the folder the queue file is in, or a full path; or a repository address, which is cloned first. Optional: without it the app keeps the folder it has. Like `--src`, it switches the app to that folder. |
| `noCache` | `true` to skip the build cache. Optional. |
| `cancel` | Add `"cancel": true` to an entry that is waiting or running to cancel it. |

### A repository as the source

`src` can be a repository address instead of a folder:

```json
{ "app": 3, "src": "https://github.com/owner/my-project" }
```

During the checks step Liftoff clones it into the queue file's folder, as `my-project`, and deploys from that copy. If that folder is already there, it is used as it is: no clone, and no update either, so pull it yourself (or delete it) when you want newer code. A folder of that name holding a different repository stops the deploy rather than being used.

- A branch: `https://github.com/owner/my-project/tree/staging`, or `…/my-project#staging`. It only matters for the first clone.
- SSH addresses (`git@github.com:owner/my-project.git`) work too.
- A private repository needs credentials git already has on this computer. Liftoff never asks for them; without them the clone fails and the entry is marked `failed`.
- The same works with `liftoff deploy my-app --src <address>`, the Add entry form and the endpoint. In an address, a URL has to be encoded: `?src=https%3A%2F%2Fgithub.com%2Fowner%2Fmy-project`; a JSON body avoids that.

### Leaving the app out

An entry with only a folder, `{ "src": "my-project" }`, lets Liftoff choose the app and writes the chosen number onto the entry:

1. If an app already deploys that folder, the entry goes to it: a redeploy.
2. Otherwise it goes to a free app: one with a stored password that has never had an image pushed and has nothing waiting. The lowest number goes first.

An app that already serves another project is never taken over. When nothing is free the entry is `rejected` with the reason, and you name the app yourself.

Liftoff checks the file once a second while `liftoff serve` (or `liftoff watch`, which does the same without the page) is running. Every entry that has no `status` yet is deployed, in file order, one at a time. The result is written back onto the same entry:

```json
{ "app": 1, "src": "my-project", "id": "d0mwdb75vwc0a5", "status": "verified", "asked": "2026-11-12 14:21:55", "took": "54s", "image": "sha256:13ee…", "url": "https://my-project-xo-abc123.apps.hello-xo.nl" }
```

`url` is added once the deploy has succeeded: the address the app answers at. Launchpad serves each app at its own id, so `registry.xo.builders/my-app-xo-abc123/app` gets `https://my-app-xo-abc123.apps.hello-xo.nl`; a live address set on the app is used instead when there is one.

`status` is one of `waiting`, `running`, `verified`, `pushed` (pushed but the registry could not confirm it), `failed`, `cancelled`, or `rejected` (the entry could not be started; `error` says why, for example an unknown app number or a missing folder). An entry is handled once: to deploy again, add another entry.

The **Queue** page and `liftoff queue` show this file, newest entry first. Deploys started with the Deploy button or `liftoff deploy` are added to the file as well, so the file is the whole queue.

### Adding an entry over HTTP

While `liftoff serve` is running, the **Add entry** form on the Queue page, or a script, can add the entry instead of editing the file. Put the fields in the address, so there is nothing to quote:

```powershell
Invoke-RestMethod -Method Post "http://localhost:5438/api/queue?app=1&src=my-project"
```

```sh
curl -X POST "http://localhost:5438/api/queue?app=1&src=my-project"
```

In Windows PowerShell, `curl` is not the real curl; use `Invoke-RestMethod` as above, or `curl.exe`. A JSON body (`{"app": 1, "src": "my-project"}` with `Content-Type: application/json`) works too, from tools that send it intact.

The fields are the same as in an entry: `app`, and optionally `src` and `noCache`. The entry is written to the end of the queue file and its deploy starts at once. The answer is `201` with the entry, including its `id` and `status`; `GET /api/queue` shows how it went. An unknown app or a missing folder is answered with `400` and nothing is written. Like the rest of the API, it only answers requests from this computer.

The file starts out as `queue.json` in the data folder. Move it next to your projects so short relative folders work: **Move the file…** on the Queue page, or `liftoff queue-file D:\projects\queue.json`.

Things worth knowing:

- Entries added while Liftoff is not running are deployed as soon as it starts.
- If the file is not valid JSON at the moment you save it, nothing starts and the file is left untouched; the Queue page says what is wrong. A comma left after the last entry is forgiven.
- Liftoff rewrites the file to add results. Use an editor that reloads files changed on disk (VS Code does). If an editor saves an older copy without the results, Liftoff puts them back rather than deploying those entries again, as long as you only added lines.
- Removing entries from the file only removes them from the queue page; each app's own history keeps them.
- A waiting deploy belongs to the Liftoff that started it. If that one is closed before the deploy's turn comes, the deploy is marked failed rather than run later.

Because the password comes from the store, a script, a scheduled task or an AI coding agent can run `deploy` without ever seeing it.

## The queue on spacehub

The queue file can live in a spacehub project, so entries can be added from the hub and the results seen there. The setup on this machine:

- `hub/quirq/` is a clone of the quirq space; `hub/quirq/launch/` is the project `quirq/launch`.
- Liftoff's queue file is `hub/quirq/launch/queue.json`. Relative `src` folders therefore start in that project's folder; `../website` is the space's website project.
- `hub-sync.cmd` (or `node scripts/hub-sync.mjs`) keeps that folder in step with the hub both ways, pushing as the agent `liftoff`. It runs spacehub's autosync and starts it again if it stops.

Both have to be running: `liftoff serve` to deploy new entries, and `hub-sync` to carry the file to and from the hub.

Before relying on it:

- **Everyone who can push to the project can deploy.** An entry added on the hub by any member of the space, or any agent connected to it, is built on this computer and pushed to a live app. It can name any repository as its source.
- **The project can be read by anyone who can reach the hub.** The queue file shows app numbers, folders, repository addresses, image digests, app addresses and error messages. It never holds a password.
- Liftoff writes each status change into the file and autosync commits it, so the project's history fills with `autosync: queue.json` commits.
- If an edit on the hub and a status change here touch the same line at the same moment, autosync stops on a conflict (`hub-sync` says so). Resolve it in the folder with git, then start `hub-sync` again.

## How the password prompt is avoided

`docker login` only asks for the password when it has to read it from a keyboard. It also accepts it on standard input:

```sh
docker login registry.xo.builders -u xo-my-app-xo-abc123+push --password-stdin < password.txt
```

Liftoff does exactly that, with the password coming from its encrypted store instead of a file.

One more thing gets in the way when you have several Launchpad apps. Docker remembers a single login per registry host, and every Launchpad app has its own push account on the same host, `registry.xo.builders`. Logging in for one app replaces the login of the other. So Liftoff does not log in through your normal Docker settings. For the login step and for the push step it creates a private, throwaway Docker config folder, uses it for that one command, and deletes it. Your own `docker login` state is never changed.

Where the password is, and is not:

| | |
| --- | --- |
| At rest | In `vault.json` in the data folder, encrypted with Windows data protection (DPAPI) for your Windows account. Another user, or another computer, cannot decrypt it. On macOS and Linux the fallback is AES-256 with a key file beside the vault, which only keeps it out of plain sight. |
| During login and push | Unencrypted inside the throwaway Docker config folder in your temp directory, for as long as that one command runs. This is how Docker itself holds a login when no credential helper is configured. |
| Never | On a command line, in a log, in a deploy record, in the app's settings, or in anything the page receives back. Output is scrubbed of the password in all its encoded forms before it is written. |

The build step runs with your normal Docker settings, so base images from registries you are logged in to keep working.

## What a deploy does

| Step | What happens | Stops the deploy when |
| --- | --- | --- |
| Checks | Source folder and Dockerfile exist, a password is stored, Docker is running. Notes the git branch and commit. | Anything is missing. |
| Login | `docker login <registry> -u <user> --password-stdin` | The registry rejects the login. Nothing is built. |
| Build | `docker build --platform <platform> -t <image> .` in the source folder | The build fails, or the image came out for the wrong platform. Nothing is pushed. |
| Push | `docker push <image>` | The registry refuses it. |
| Verify | Asks the registry what the tag points to and compares it with the digest docker reported. | The tag is missing or points to a different image. |

A deploy ends **verified** when the registry confirmed the digest. If the push account is not allowed to read the tag back, the deploy still counts and is marked **pushed, not confirmed**. Launchpad picks up a pushed `latest` by itself.

## Where things are kept

Everything lives in `~/.liftoff` (`C:\Users\<you>\.liftoff`). Use `--home <folder>` or the `LIFTOFF_HOME` variable for another place.

```
apps.json                      the apps and their settings, no secrets
vault.json                     the encrypted passwords
deployments/<app>/<id>.json    one record per deploy: steps, timings, digest, git commit
deployments/<app>/<id>.log     that deploy's output
queue.json                     the queue file (unless you moved it; settings.json remembers where)
active/                        one marker per deploy that is waiting or running
```

Removing an app in Liftoff deletes its settings, password and history from this folder. It changes nothing on Launchpad or in the registry.

## Safety of the local page

The server can start builds and push with stored passwords, so it only listens on the loopback address and only answers its own page: requests from other sites open in your browser, or addressed to it by another host name, are refused, and it sends no CORS headers.

## Tests

```sh
npm test            # no Docker needed (a stand-in docker and a stub registry)
npm run test:e2e    # real docker against a throwaway registry in a container
```

The end-to-end check needs Docker running and the `python:3.12-slim` image on the machine. It deploys a tiny image through the real pipeline against a registry that hands out tokens like Harbor and one that takes the password directly, checks that your Docker settings are unchanged, and removes what it created.

## Limits

- The image name must include the registry host. Docker Hub short names such as `user/app` are not supported.
- One deploy at a time across all apps; the rest wait in the queue.
- The private Docker config reaches the engine your current Docker context points to by its address. Remote engines that need client certificates are not carried over.
- Old images stay in Docker after each deploy, as they do when you build and push by hand.
