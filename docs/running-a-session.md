# Running a session with local models

This guide covers what Plan 2A delivers: checking your model servers with `sim bench` and playing a session with `sim run`. Lore retrieval (Plan 2B), generated characters and session prep (Plan 2C), and voices, art, and playback (Plans 3–4) come later.

## 1. Install

```bash
npm ci
```

Node 22.22 or newer is required.

## 2. Start an OpenAI-compatible server for each seat

Every seat (the DM and each player) talks to an OpenAI-compatible `/v1` endpoint. Seats can share a server or each use a different machine.

- **LM Studio:** load the model, open the Developer tab, start the server, and enable "Serve on Local Network" so other machines can reach it. The default base URL is `http://<machine>:1234/v1`.
- **llama.cpp:** `llama-server -m <model>.gguf --host 0.0.0.0 --port 8080 --jinja`. The `--jinja` flag enables tool calling. The base URL is `http://<machine>:8080/v1`.
- **mlx_lm:** `mlx_lm.server --model <model> --host 0.0.0.0 --port 8080`.

The engine asks every call to use a tool. If a server ignores that and replies with plain text, set `toolChoice: auto` on that seat (see below) so a text reply is used as narration or speech instead of counting as a failure.

## 3. Create a campaign

Copy the example into your campaigns directory (`./campaigns` by default; it is git-ignored):

```bash
mkdir -p campaigns && cp -R apps/cli/examples/local-campaign campaigns/avalon
```

Then edit `campaigns/avalon/campaign.yaml`:

```yaml
name: Avalon
targetMinutes: 60
endpoints:
  macbook: { baseURL: http://127.0.0.1:1234/v1 }
  studio: { baseURL: http://192.168.1.20:1234/v1 }
  ampere: { baseURL: http://192.168.1.30:8080/v1 }
seats:
  dm:
    endpoint: macbook
    model: <model id as the server lists it>
    temperature: 0.8
    fallbacks:
      - { endpoint: ampere, model: <backup model id> }
  players:
    kira: { endpoint: studio, model: <model id>, temperature: 0.9 }
    tomas: { endpoint: ampere, model: <model id>, toolChoice: auto }
```

Seat options: `temperature`, `maxOutputTokens`, `timeoutMs` (default 120000), `toolChoice` (`auto` or `required`), and `fallbacks` (tried in order when a call fails). A hung primary costs up to its `timeoutMs` on every call before its fallback is tried, since there is no sticky memory of a target that recently timed out.

Each party member is a file in `characters/` (for example `characters/kira.yaml`). Every party member needs a seat under `seats.players`, and every seat there needs a matching character. The example characters are placeholders until `sim chargen` arrives in Plan 2C.

## 4. Check the seats

```bash
npm run sim -- bench --campaign avalon
```

For each seat this reports whether the server answered, whether it lists the configured model id, generation speed in tokens per second, and how many of the tool-call trials (default 5, `--trials N`) were well-formed. For a `toolChoice: auto` seat, a trial where the model replies with text instead of a tool call counts as usable too and is shown separately, e.g. `3/5 (+2 text)`. A report is saved to `campaigns/avalon/bench/<timestamp>.json`. The command exits with code 1 if any seat is unreachable or a trial returns a malformed or wrong tool call.

## 5. Play a session

```bash
npm run sim -- run --campaign avalon --target-minutes 10
```

Public events print as they happen, and every event is appended to `campaigns/avalon/sessions/001/events.jsonl`. Use `--session N` for later sessions and `--seed N` for reproducible dice.

Until Plan 2B there is no lore index: every lore lookup reports a gap, and the DM invents details and records them with `record_invention`.

## 6. Pauses and resuming

A session pauses (exit code 2) instead of crashing when:

- a seat keeps failing after its fallbacks and the retry delays (the message names the seat);
- nobody has spoken or changed the game state for 12 turns in a row;
- the DM hands off 3 times in a row with no player character able to respond.

Fix the cause, then continue with the same command plus `--resume`: the log is the source of truth, so resuming uses the logged party, target minutes, and lore commit, and a backstop pause (the last two cases above) gives the table a fresh budget of turns or hand-offs. If the cause is unfixed, play continues until the same backstop trips again after another full limit.

Ctrl-C releases the session lock before exiting. If a run was killed without releasing it, the next run replaces a lock whose process is no longer running and says so.
