# Example campaign

A starting point for `npm run sim -- bench --campaign <id>` and `npm run sim -- run --campaign <id>`.

Copy this folder into your campaigns directory (default `./campaigns`), then point `campaign.json` at your model servers:

```bash
mkdir -p campaigns && cp -R apps/cli/examples/local-campaign campaigns/avalon
```

- `endpoints` names each OpenAI-compatible server. LM Studio listens on port 1234 by default.
- `seats` gives the DM and each party member an endpoint and a model. Use the exact model ids each server lists; `sim bench` reports whether a configured model is listed.
- `characters/` holds one `<id>.json` per party member, and each needs a seat under `seats.players`. Kira and Tomas are placeholders until `sim chargen` (Plan 2C) drafts real characters from the lore.

See `docs/running-a-session.md` for every option.
