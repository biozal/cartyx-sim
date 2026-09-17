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
- **Ollama:** listens on port 11434, so the base URL is `http://<machine>:11434/v1`. Its default context is 8192 tokens, which long sessions outgrow; set `OLLAMA_CONTEXT_LENGTH` (for example 16384) for the Ollama service.

The engine asks every call to use a tool. If a server ignores that and replies with plain text, set `"toolChoice": "auto"` on that seat (see below) so a text reply is used as narration or speech instead of counting as a failure.

## 3. Create a campaign

Copy the example into your campaigns directory (`./campaigns` by default; it is git-ignored):

```bash
mkdir -p campaigns && cp -R apps/cli/examples/local-campaign campaigns/avalon
```

Then edit `campaigns/avalon/campaign.json`:

```json
{
  "name": "Avalon",
  "targetMinutes": 60,
  "endpoints": {
    "macbook": { "baseURL": "http://127.0.0.1:1234/v1" },
    "studio": { "baseURL": "http://192.168.1.20:1234/v1" },
    "ampere": { "baseURL": "http://192.168.1.30:8080/v1" }
  },
  "seats": {
    "dm": {
      "endpoint": "macbook",
      "model": "<model id as the server lists it>",
      "temperature": 0.8,
      "fallbacks": [{ "endpoint": "ampere", "model": "<backup model id>" }]
    },
    "players": {
      "kira": { "endpoint": "studio", "model": "<model id>", "temperature": 0.9 },
      "tomas": { "endpoint": "ampere", "model": "<model id>", "toolChoice": "auto" }
    }
  }
}
```

The files are plain JSON: no comments and no trailing commas. A malformed file is reported with its path.

Seat options: `temperature`, `maxOutputTokens`, `timeoutMs` (default 120000), `toolChoice` (`auto` or `required`), and `fallbacks` (tried in order when a call fails). A hung primary costs up to its `timeoutMs` on every call before its fallback is tried, since there is no sticky memory of a target that recently timed out. Runs are generated offline, so a generous `timeoutMs` (for example `300000`) costs only run time, while a thinking turn that outlasts a short one fails and can pause the session.

Give a seat `fallbacks` even when its primary server is otherwise reachable: a seat that keeps _answering_ without ever calling a tool exhausts its retries against the same stuck target just as surely as one that times out, and pauses the session either way. In one 1-hour run, a player seat answered four times running with no tool call and paused the session at 49 minutes; a fallback to a different model on a second endpoint means a repeat of that failure is retried somewhere that can actually respond, instead of against the same seat.

**Thinking models need room.** `maxOutputTokens` counts the model's thinking as well as its reply, and current Qwen, Gemma, and GLM models think for hundreds of tokens before calling a tool. A seat whose limit is too small stops mid-thought with no tool call, and the session pauses on that seat. Starting points that work: `2000` for players and `4000` for the DM. LM Studio does not enforce required tool calls, and Qwen often narrates in plain text after a tool result, so give a DM seat on LM Studio `"toolChoice": "auto"`. Keep players on `required`, so a garbled tool call is retried rather than spoken. `sim bench` uses a simple dice-roll trial, which does not show this; a short `sim run` does.

Each party member is a file in `characters/` (for example `characters/kira.json`). Every party member needs a seat under `seats.players`, and every seat there needs a matching character. The example characters are placeholders until `sim chargen` arrives in Plan 2C.

## 4. Check the seats

```bash
npm run sim -- bench --campaign avalon
```

For each seat this reports whether the server answered, whether it lists the configured model id, generation speed in tokens per second, and how many of the tool-call trials (default 5, `--trials N`) were well-formed. For a `toolChoice: auto` seat, a trial where the model replies with text instead of a tool call counts as usable too and is shown separately, e.g. `3/5 (+2 text)`. A report is saved to `campaigns/avalon/bench/<timestamp>.json`. The command exits with code 1 if any seat is unreachable or any trial is not a well-formed `roll_dice` call (for a `toolChoice: auto` seat, a plain-text reply also counts as usable).

## 5. Play a session

```bash
npm run sim -- run --campaign avalon --target-minutes 10
```

Public events print as they happen, and every event is appended to `campaigns/avalon/sessions/001/events.jsonl`. Use `--session N` for later sessions and `--seed N` for reproducible dice.

Until Plan 2B there is no lore index: every lore lookup reports a gap, and the DM invents details and records them with `record_invention`.

The engine also catches a few DM slips on its own, without failing the turn. If a narration accidentally includes prompt bookkeeping — a combatant's `(id: …)`, an `HP x/y` block, or an "It is `<name>`'s turn" line — those lines are cut before the narration is spoken, flagged `dm_state_leak`, with a DM-only note listing what was cut. If a narration repeats a sentence the DM already said this beat, or quotes back four or more words of a player's own recent line, that sentence is cut too, flagged `repeated_text`, with the same kind of note. Either cut can empty the whole narration, in which case the call is rejected and the DM tries again, same as any other fully-cut narration. A `tool_error` or `invalid_tool_call` — whether the DM's or a player's — now also writes a DM-only note (`Tool error (<tool>): <message>` or `Invalid tool call (<tool>): <message>`) in addition to the message sent back to the model, so the error is visible in the log without re-running the session.

A player character dropped to 0 HP does not sit out: they keep their place in the initiative order, and each round the engine itself rolls a death saving throw for them — no model call, nothing for their seat to answer. The log shows a roll line, `[roll] Kira Vale death saving throw: 12 vs 10 — success`, followed by a state line with the running tally, `[state] Kira Vale death saves: 2 successes, 1 failure`. A natural 20 wakes the character at 1 HP, so their next turn is a normal one again; a third failure kills them; a third success stabilizes them (`[state] Kira Vale is stable`), and they stay unconscious at 0 HP, skipped for turns, until healed.

## 6. Pauses and resuming

A session pauses (exit code 2) instead of crashing when:

- a seat keeps failing after its fallbacks and the retry delays (the message names the seat);
- nobody has spoken or changed the game state for 12 turns in a row;
- the DM hands off 3 times in a row with no player character able to respond.

Fix the cause, then continue with the same command plus `--resume`: the log is the source of truth, so resuming keeps the logged target minutes (a differently configured value is ignored, with a note in the log), and the party and lore commit must match the log or the resume is refused. A backstop pause (the last two cases above) gives the table a fresh budget of turns or hand-offs; if the cause is unfixed, play continues until the same backstop trips again after another full limit.

Ctrl-C releases the session lock before exiting. If a run was killed without releasing it, the next run replaces a lock whose process is no longer running and says so.

Any other error prints its message and exits 1, without a stack trace. Set `SIM_DEBUG=1` to print the stack instead.

## 7. Keep the DM from playing the players (optional)

Models acting as DM tend to write dialogue, thoughts, and actions for the player characters. An optional checker seat reviews every DM narration against what the players declared since the DM last spoke. The DM may describe a character carrying out the action its player declared; it may not write that character's dialogue, thoughts, feelings, or choices, or have them do anything undeclared.

With a checker seat configured, the older verb-list check for the DM playing a player character is off; the checker judges instead — until the checker disables itself after repeated failures, when it takes over again. (The check for inventing damage, healing, HP, or roll numbers without a tool still runs either way.)

When the checker finds sentences that cross that line, the DM is asked to rewrite once; if it does it again in the same turn, just those sentences are cut. Prose the engine made into narration (text the DM wrote alongside its tool calls rather than through `narrate`) is cut right away, without a retry. Each case is logged as a `dm_controls_pc_checker` flag (`re_prompted` or `trimmed`), and cut sentences are listed in a DM-only note. A thinking checker sometimes spends its whole output budget thinking and returns an empty or cut-off reply; that is retried once on the same target, then tried on each fallback, before the narration goes out unchecked. If the checker is down or its reply is unreadable, the narration goes through unchecked with a note; after 3 failures in a row, checking stops for the rest of the run. The checker never pauses a session. The DM's rejected draft and the checker's raw reply are also kept in DM-only notes, so a reviewer can see exactly what was rejected and why.

Add it under `seats` in `campaign.json`:

```json
"checker": {
  "endpoint": "ampere",
  "model": "glm-4.7-flash:latest",
  "temperature": 0.2,
  "maxOutputTokens": 4000,
  "timeoutMs": 300000,
  "fallbacks": [{ "endpoint": "macbook", "model": "<a fast model id>" }]
}
```

The example leaves thinking on. Sessions are generated offline and the session clock counts spoken words, not wall time, so a slower check only makes the run take longer, and thinking checkers flag more precisely. Thinking counts against `maxOutputTokens`, so give the checker room. `timeoutMs` applies to the checker and to each fallback, so with a 5-minute timeout a hung checker can hold up one narration for up to 10 minutes; three failures in a row disable checking for the rest of the run. To trade precision for speed, add `"reasoningEffort": "none"` to turn thinking off; any seat accepts `reasoningEffort` (`none`, `low`, `medium`, or `high`). `sim bench` checks the checker seat's reachability and speed but runs no tool-call trials for it, so its tool-calls column shows `0/0`.

## 8. Make a script

`sim script` turns a finished session's event log into two files next to it:

- `script.json`: every spoken line in order, with its speaker, cleaned for text-to-speech, plus silent cues for rolls, scenes, combat, and HP or condition changes. This is what the voice and playback stages read.
- `script.md`: the same session as a readable script.

```bash
npm run sim -- script --campaign avalon --session 3
```

The event log is never changed, and the script never adds words: it only drops, splits, and attributes text from the log.

- **Player lines:** a stage direction between quotes (`"…" I keep my voice low. "…"`) is dropped from the spoken line and shown as an aside in `script.md`. Stray quote marks and markdown are removed. Slips such as "Kira's — I mean, my — take" stay as spoken.
- **Actions** are spoken in the player's voice.
- **DM narration:** `DM:` prefixes, hand-off lines, and markdown are removed, and each paragraph (and each heading or list item) becomes its own line.
- **NPC speech inside narration** becomes its own line. A model decides who speaks each quote: a known NPC, a new NPC (given an id like `npc-faceless-creature` and listed as unlisted), a player character, or no one (a sign, a name, a single word). The model only returns these labels, never text. A quote the DM wrote for a player character stays in the DM's voice and is marked `DM (as Kira Vale)`.

The labeling seat is `seats.script` in `campaign.json` when present, otherwise `seats.checker`; with neither, or with `--no-model`, rules decide: a quote of fewer than three words is not speech, and any other goes to the only NPC introduced in the current scene, or to `npc-unnamed`. A failed or unusable model reply is retried once, then rules decide for that narration and a note says why. `sim bench` checks a `script` seat's reachability and speed like the checker's, without tool-call trials.

```json
"script": {
  "endpoint": "ampere",
  "model": "glm-4.7-flash:latest",
  "temperature": 0.2,
  "maxOutputTokens": 4000,
  "timeoutMs": 300000
}
```

Model answers are cached in `sessions/NNN/.script-cache/`, so re-running is free and gives the same result. `--refresh` asks the model again. When a fallback model answers instead of the primary (`fallbacks` is configured on the seat, not the endpoint), its reply is cached under the fallback's own key, never the primary's; a later rerun still asks the primary first, so a real answer from it is never shadowed by a cached fallback reply. With `--no-model`, or a campaign with no `script` or `checker` seat, nothing labels quotes, so `--refresh` has no effect; it prints a line saying so rather than silently doing nothing.

`script.md`'s header names the event log it was built from: `` - Events: `<first 12 hex chars of eventsSha256>` ``, matching `script.json`'s `eventsSha256`. A script rebuilt from the same log always shows the same hash; a different one means the log changed underneath it.

To rename or merge speakers, add `sessions/NNN/speakers.json` and re-run:

```json
{
  "npc-faceless-creature": { "name": "The Faceless One" },
  "npc-thing": { "id": "npc-faceless-creature" }
}
```

`name` renames a speaker; `id` merges one NPC into another. Unknown speakers and merges into a player character or the DM are errors.

`sim script` refuses to start while the session is being played: it takes the same lock as `sim run`, but only while it reads and hashes the log, releasing it before labeling and writing the outputs. It prints a summary: lines by kind, spoken words, how quotes were labeled, dropped stage directions, unlisted speakers, and notes. `script.md` and `script.json` are written as a pair, with `script.json` written last, so its presence marks a complete build.

Like `sim run`, any other error prints its message and exits 1; set `SIM_DEBUG=1` to print the stack instead.
