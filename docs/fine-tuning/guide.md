# Teaching a small model to play D&D: a field guide

This guide follows the project step by step: what we did, why, and the ideas behind it. It is written so
you can explain the work to someone who has never trained a model. Each chapter is added as the work
happens; numbers are the ones we measured, not textbook figures.

**The goal:** take an existing open model small enough to run on a 16 GB graphics card (an RTX 5060 Ti
class card), and make it a better Dungeons & Dragons player in the cartyx-sim: reliable, engaged,
rules-savvy, and at home in the Cartyx world. The training runs on our own hardware, the "Ampere"
server with an RTX 3090 (24 GB) and an RTX 4070 (12 GB).

---

## Chapter 1 — The big picture and the decisions behind it (2026-10-15)

### How a language model learns, in three stages

1. **Pretraining.** A company trains a model on trillions of words of public text. This is where it
   learns language, facts, and how the world works — including a great deal about D&D, because the
   internet is full of it. This costs millions of dollars; we never do this step.
2. **Instruction tuning.** The same company teaches the pretrained model to follow instructions, chat,
   call tools and think step by step. The models we download ("instruct" or "chat" models) have had
   this done.
3. **Fine-tuning.** We take that finished model and train it a little more on our own examples, to
   change _how it behaves_ for our task. This is the step this project is about. It is cheap enough
   to do on one graphics card, in hours rather than months.

A useful mental model: pretraining decides what the model _knows_; fine-tuning mostly changes what it
_does with_ what it knows — its habits, style, format and judgement.

### Why we do not teach it the world by training

The obvious idea is to train the model on all of the Cartyx lore (about 915,000 words across 2,421
files) so it simply "knows" the world. Research says this works badly:

- **Models learn new facts slowly through fine-tuning.** In one comparison (Ovadia et al., 2024),
  looking facts up at answer time scored 0.875 on new facts; training them in scored 0.504.
- **Learning new facts makes models invent more.** Gekhman et al. (2024) found that as a model is
  trained on facts it did not already know, its tendency to make things up rises in step. It learns
  that "confidently stating things I wasn't sure of" is what's wanted.
- **The lore changes.** Anything trained in is frozen; a retrain would be needed after every edit.

So world knowledge comes from **retrieval** (often called RAG, "retrieval-augmented generation"): at
play time, the sim searches the lore index and puts the relevant passages into the model's prompt.
The sim already does this for the Dungeon Master, and session 019 showed it works: 31 lore entities
used, nothing invented. We will extend it to players. What we _train_ is the skill of using those
passages well — speaking in character about the places and people they describe, and not inventing
beyond them.

The one thing we do train in is **rules know-how**. Models already know D&D 5e from pretraining; the
2024 revision is a modest set of changes on top. That's close enough to what the model knows that
training helps rather than hurts, as long as each rule is taught through many varied, checked
examples rather than by feeding it the rulebook.

### What we are allowed to train on

- **The 2024 rules:** only the **SRD 5.2.1** (System Reference Document), which Wizards of the Coast
  released under Creative Commons CC-BY-4.0 in April 2025. That licence allows any use, including
  training, with attribution, and cannot be revoked. The full 2024 Player's Handbook, Dungeon
  Master's Guide and Monster Manual are copyrighted and stay out.
- **The Cartyx world:** it's ours.
- **Examples written by other models:** we use open-weight models (Qwen, Gemma) as "teachers". Their
  licences allow it. Most commercial AI services forbid training other models on their output, which
  is why we chose local teachers.

### Choosing the model: size, memory and "quantization"

A model is a huge table of numbers called **parameters** or **weights**. A "9B" model has 9 billion.
Memory needed is roughly _parameters × bytes per parameter_:

| Precision | Bytes per weight | 9B model | 12B model |
| --------- | ---------------- | -------- | --------- |
| 16-bit    | 2                | ~18 GB   | ~24 GB    |
| 8-bit     | 1                | ~9 GB    | ~12 GB    |
| 4-bit     | 0.5              | ~4.5 GB  | ~6 GB     |

**Quantization** means storing the weights with fewer bits. It loses a little quality but makes a model
fit on smaller cards. On top of the weights, the card needs room for the **context** — the prompt and
the reply — whose memory (the "KV cache") grows with prompt length. Player prompts in the sim run
2,000–6,000 tokens, so a 9B model at 8-bit (~10 GB) plus its context fits a 16 GB card comfortably.

Candidates that fit, all released in 2026:

- **Qwen3.5-9B** (Apache 2.0 licence) — our first choice: strongest for its size, and it calls tools.
- **Gemma 4 12B** — already a seat in the sim (Bram); a strong alternative.
- **Gemma 4 E4B** — a fallback if 9–12B models are too slow on a 5060.

### How fine-tuning fits on one card: LoRA

Training normally adjusts every weight, and needs memory for the weights, their gradients (how each
should change) and optimizer bookkeeping — roughly four times the model's size. A 9B model would need
about 70 GB.

**LoRA** (Low-Rank Adaptation) avoids this. It freezes the original weights and trains a small set of
extra numbers — an "adapter", typically under 1% of the model's size — that nudges the model's
behaviour. Only the adapter needs gradients, so memory drops to about the model's own size plus a bit.
Afterwards the adapter can be merged into the model, or kept as a separate file you swap in and out.

**QLoRA** goes further by holding the frozen model in 4-bit during training. It's cheaper, but the
tooling we use (Unsloth) advises against it for the Qwen 3.5 family, whose accuracy drops more than
usual when quantized. So for Qwen3.5-9B we use 16-bit LoRA, which Unsloth puts at about 22 GB — it
fits the 3090's 24 GB with little to spare. That's why the 3090 does the training. The 4070 can't
usefully share the work: the free version of Unsloth trains on a single card, and splitting one model
across a 24 GB and a 12 GB card is fragile. The 4070 instead can serve a model for scoring or for the
sim while the 3090 trains.

Unlike playing a session, training needs the whole card, so while a training run is going the Ampere
leaves the sim: Ollama stops, and Mira and the checker's fallback move to other machines in the
campaign config.

### Using every machine we have

One training run can't be spread across several computers in any practical way: the machines would
spend more time sending numbers to each other over the network than computing. So extra machines
don't make _one_ run faster. They make the _project_ faster, in three ways:

1. **Making training data.** The slowest part of the project isn't training, it's playing the
   thousands of turns we train on. Every machine that can serve a model is a seat for the
   data-generating sessions, and several sessions can run at once.
2. **Running experiments side by side.** Which starting model, how many passes over the data, how
   strong an adapter — each is a separate run. Separate machines can try them at the same time.
3. **Teaching and judging.** The Macs' large memory runs big teacher and judge models well, while
   the NVIDIA cards train.

| Machine                  | Memory                | Best use                                                                                   |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------ |
| Ampere — RTX 3090        | 24 GB                 | Main training runs (Qwen3.5-9B, 16-bit LoRA).                                              |
| Ampere — RTX 4070        | 12 GB                 | Serving a small model while the 3090 trains.                                               |
| Linus — RTX 5060 Ti      | 16 GB                 | Small experiments (Gemma 4 E4B), and testing the result on the card size we're aiming for. |
| Windows PC — RTX 5070 Ti | 16 GB                 | A second small-experiment card; same software as the 3090.                                 |
| MacBook Pro — M5 Max     | 128 GB unified memory | Teacher and judge models; can also train (MLX) when memory matters more than speed.        |
| Mac Studio — M2 Ultra    | 64 GB unified memory  | Teacher and judge models; data-generation sessions.                                        |

**NVIDIA versus Apple for training.** NVIDIA cards train roughly two to four times faster than Apple
chips on a model that fits in the card's memory: published figures for LoRA on an 8B model are about
800–1,500 tokens a second on a 3090 against 250–400 on an M5 Max. Apple's strength is memory — a Mac's
"unified" memory is shared by processor and graphics, so the M5 Max can hold 128 GB where the 3090
holds 24 — which lets it train models or prompt lengths that would not fit on a card at all. Apple
machines train with a different toolkit (MLX instead of Unsloth), so keeping the main runs on the
NVIDIA cards means one set of training code; the Macs train only if we hit the 3090's memory limit.

**Renting.** For a one-off large run, cloud providers rent an 80 GB data-centre card for a few dollars
an hour. Not needed yet; noted in case a run outgrows the 3090.

### Two kinds of training we will use

- **SFT (supervised fine-tuning):** show the model thousands of examples of a prompt and the ideal
  reply, and train it to produce that reply. This teaches format and habits — always calling a tool,
  speaking in a persona's voice, declaring legal actions.
- **DPO (direct preference optimization):** show it pairs — a prompt, a better reply and a worse
  reply — and train it to prefer the better one. Good for subtler judgement. The sim already produces
  such pairs: every time the checker rejects a narration and a rewrite passes, that's a pair.

### Why the player seat first

- **Short prompts.** A player prompt is 2–6k tokens; a DM prompt is 23–25k. Training memory grows with
  the length of each example, so players fit the 3090 easily.
- **Simple tools.** Players have five (`speak`, `act`, `interject`, `declare_spell`, `pass`); the DM
  has dozens.
- **Clear problems to fix.** This week Kira's model ran out of tokens while thinking, and Tomas speaks
  about 1% of the words.

### What "better" means — the four goals

1. **Reliable and fast:** every reply is a valid tool call; no running out of tokens while thinking;
   quick on a 16 GB card. (A bonus of fine-tuning: we can teach shorter thinking.)
2. **Engaged roleplay:** speaks in a distinct voice true to the persona, reacts to the other players,
   pushes the scene forward.
3. **Rules-savvy play:** declares legal 2024 actions, spells and checks the way an experienced player
   would.
4. **Knows the world:** uses Cartyx's real places, people and institutions in character, from the lore
   it is given.

### The plan: five sub-projects

| #   | Sub-project          | What it delivers                                                                                                                                         |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Player scorecard     | `sim score` — grades each player seat on the four goals from a session's event log, and a baseline for today's models.                                   |
| 2   | Player lore          | Players get a small, player-safe slice of lore in their prompt.                                                                                          |
| 3   | Training data        | `sim export` turns player turns into training examples; local teacher models play many sessions to make more; SRD rules scenarios checked by the engine. |
| 4   | Training             | A Python `training/` folder that trains Qwen3.5-9B with LoRA on the 3090 and exports it for Ollama / LM Studio.                                          |
| 5   | Evaluate and iterate | The trained model plays, is scored against the baseline, then a DPO pass on better/worse pairs.                                                          |

The scorecard comes first because "better" means nothing until we can measure it — and measuring
today's models also tells us which one is the best starting point.

### Glossary

- **Parameters / weights:** the numbers that make up a model. "9B" = 9 billion.
- **Token:** a chunk of text the model reads or writes, about ¾ of a word.
- **Context / context window:** everything the model sees at once — prompt plus reply.
- **Quantization:** storing weights with fewer bits (8-bit, 4-bit) to save memory.
- **Fine-tuning:** further training a finished model on your own examples.
- **LoRA / QLoRA:** fine-tuning a small add-on adapter instead of the whole model; QLoRA keeps the
  frozen model in 4-bit.
- **SFT:** training on example prompts with ideal replies.
- **DPO:** training on pairs of a better and a worse reply.
- **RAG / retrieval:** looking information up and putting it in the prompt at answer time.
- **Teacher model:** a stronger model whose good outputs become training examples for a smaller one.
- **GGUF:** the file format Ollama and LM Studio load models from.
- **SRD:** the free, openly licensed core of the D&D rules.

### Sources

- Ovadia et al., _Fine-Tuning or Retrieval? Comparing Knowledge Injection in LLMs_ (EMNLP 2024): https://arxiv.org/pdf/2312.05934
- Gekhman et al., _Does Fine-Tuning LLMs on New Knowledge Encourage Hallucinations?_ (EMNLP 2024): https://aclanthology.org/2024.emnlp-main.444
- SRD 5.2 announcement: https://www.dndbeyond.com/posts/1949-you-can-now-publish-your-own-creations-using-the
- Unsloth, Qwen3.5 fine-tuning (VRAM figures, QLoRA advice): https://unsloth.ai/docs/models/qwen3.5/fine-tune
- Unsloth, Gemma 4 training: https://unsloth.ai/docs/models/gemma-4/train
- Unsloth, multi-GPU training: https://unsloth.ai/docs/basics/multi-gpu-training-with-unsloth

---

## Chapter 2 — Measuring "better" before changing anything (2026-10-15)

Before training anything we need a way to score a player, for two reasons. First, "the trained model
plays better" is only a claim until it's a number. Second, the same scores decide which turns are good
enough to become training examples — a model trained on mediocre examples learns mediocrity.

### Two kinds of measurement

- **Measured scores** are counted straight from the logs: how often a reply was a valid tool call on
  the first try, how long turns took, what share of the words each player spoke, how often the rules
  engine refused a declaration, how many names a player used that exist nowhere in the lore. They are
  exact and free, but they can't tell a witty line from a dull one.
- **A judge model** reads a sample of turns and grades them 1–5 against a written rubric: does this
  sound like the character, does it react to what just happened, does it give the scene somewhere to
  go, is the declared action legal under the 2024 rules, does it fit the world. Using one model to
  grade another is called **"LLM-as-a-judge"**. It's how most AI evaluation is done today, because
  people can't read thousands of turns.

Judges have biases — they tend to prefer longer answers, and answers that sound like their own style.
So we **check the judge against a person**: you rate 30 turns yourself, the judge rates the same 30,
and we measure how often it lands within one point of you. Only rubric fields where it agrees with you
(within one point at least 80% of the time) count as trusted. This is the standard way to make a judge
defensible when someone asks "says who?"

### Recording every model call

Until now the sim logged the story — lines spoken, rolls, lookups — but not the model calls behind it.
We add a **call log**: for every call, the exact prompt and tools sent, the reply, the thinking,
token counts, time taken, and any retry or fallback. Two payoffs:

1. The "reliable and fast" scores come from it.
2. **It is the training data.** A training example is "this exact prompt → this ideal reply". The call
   log captures both, exactly as the model saw them, so good turns can later be lifted straight out.

### The rules, as clean files

To judge whether a declaration is legal, the judge needs the actual rules in front of it. We use the
**SRD 5.2.1**, the free, Creative Commons part of the 2024 rules. Rather than convert the 364-page PDF
ourselves, we start from an existing community conversion (downfallx/dnd-5e-srd-markdown) and check
it: 98.9% of the PDF's 204,606 words appear in it, and the missing 1.1% is almost entirely the page
footer "System Reference Document" repeated on every page.

We then split it into one file per area — each class, spells by level, monsters by letter — tidy the
monster stat blocks into compact lines, and add a test that proves the split lost no words. The rules
get their **own search index**, separate from the Cartyx lore, so a lookup for a place in the world
never returns a dragon's stat block. When the judge grades a player who casts _Mirror Image_, it is
handed the actual Mirror Image rules text.

This is retrieval again (Chapter 1): the rules are looked up and shown to the model, rather than
trusted to its memory.

### Glossary additions

- **LLM-as-a-judge:** using a language model to grade another model's output against a rubric.
- **Rubric:** the fixed list of questions and scale a grader uses, so grades are comparable.
- **Inter-rater agreement:** how often two graders (here, you and the judge) give the same or close
  scores; the evidence that a judge can be trusted.
- **Call log:** the record of every prompt sent to a model and its reply — the raw material for
  training examples.
- **Baseline:** the scores of today's models, measured before any training, that later results are
  compared against.

---

## Chapter 3 — The rules as data (2026-10-15)

This step turned the 2024 rules into files a model can be shown, and proved nothing was lost on the
way.

### What we built

- **A pinned copy of the source.** The community conversion we chose is copied into
  `data/srd-5.2.1/source/` exactly as published at one specific commit. "Pinned" means we name the
  exact version, so the text can never change underneath us. If the upstream author edits or deletes
  their repository, nothing here changes.
- **A build script** (`npm run srd:build`) that turns those 13 large files into **50 area files**:
  - the basics of play: abilities and d20 tests, actions, social interaction, exploration, combat,
    damage and healing;
  - character creation;
  - each of the 12 classes;
  - backgrounds and species;
  - feats;
  - equipment, in 7 files;
  - spell-casting rules and spells by level, in 11 files;
  - the rules glossary and gameplay toolbox;
  - magic items, as rules and A–Z;
  - monsters, as rules, four alphabetical files and animals.
- **Tidier tables.** 331 monster and animal ability-score tables became single lines, such as
  `STR 8 (−1, save −1) | DEX 15 (+2, save +2) | …`, in place of about 60 lines of HTML each. Another
  229 tables became ordinary Markdown tables. 19 were kept as HTML. Most have merged cells, such as
  the casters' "Spell Slots per Spell Level" tables, where flattening would misalign the columns.
  Five are summoned creatures' ability tables laid out differently from the rest, so the one-line
  rewrite doesn't recognize them; they read fine as they are.
- **A rules search index**, separate from the Cartyx lore: 2,598 searchable pieces ("chunks"), built
  in 15.5 seconds on the M5 Max.

What's in it: 12 classes, 4 backgrounds, 9 species, 17 feats, 339 spells (27 of them cantrips), 259
magic items, 235 monster stat blocks and 95 animals.

### Why it's built this way

**Reproducible from a pinned source.** Anyone can rerun the build and get byte-for-byte the same
files, and a test in the suite does exactly that on every run. So the claim "our rules text is the
SRD and nothing else" can be checked, not just trusted. That's also what the Creative Commons licence
asks: say where the text came from and what you changed. The README in `data/srd-5.2.1/` does both.

**A lossless check.** The build splits 1.9 MB of text. A mistake that silently dropped one paragraph
would go unnoticed by any person, and a model trained or tested on it would learn a rule with a hole
in it. So a test counts every word in the source and every word in the output, and fails if any word
is missing or extra. The only allowed differences are the titles the build adds (such as "Level 2
Spells"), the headings it removes, and exactly six words per one-line stat block: its three MOD and
three SAVE column headers go, and the word "save" appears once per ability instead. We checked that the test bites: changing one word in one file ("Three illusory duplicates"
to "Two") made it fail.

A fresh reviewer then caught a flaw in the upstream text that the word check can't see, because no
words were lost: one magic item, the Deck of Many Things, is followed by the stat block of the
creature it summons (the Avatar of Death), with headings one level too high. That placed the 132
items after it under the creature's "Actions" heading, which matters because each searchable piece
carries its heading path. The build now keeps that creature inside its item, as it already did for
spells that summon creatures, and the item count is 259, not 260.

The build also refuses to guess. If the source ever gains a section the split doesn't know where to
put, the build stops with an error naming it, rather than dropping it.

### What an embedding index is

To search the rules by meaning rather than exact words, each chunk of text is turned into an
**embedding**: a list of 768 numbers that places the text in a "meaning space", where texts about
similar things sit close together. A question is turned into numbers the same way, and the search
returns the chunks closest to it. Our first test questions:

| Question                                             | Top result                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| "can I cast two spells with spell slots in one turn" | the rule "One Spell with a Spell Slot per Turn"                |
| "what does the Grappled condition do"                | the Grappled condition in the Rules Glossary                   |
| "goblin stat block armor class"                      | how Armor Class reads in a stat block, then the Goblin Warrior |

None of those questions shares an exact phrase with the rule it found. That's the point: when the
judge (and later the model) needs the rule for what a player just declared, it can find it from the
player's own words.

### Glossary additions

- **Pinned source:** a dependency fixed to one exact version, so it can't change unnoticed.
- **Reproducible build:** a process that produces identical output every time from the same input,
  so anyone can verify the result.
- **Embedding:** a list of numbers representing a text's meaning; similar texts get similar numbers.
- **Vector index:** a database of embeddings that finds the texts closest in meaning to a question.
- **Chunk:** one searchable piece of a document — here, one section under a heading.

### Sources

- SRD 5.2.1: https://www.dndbeyond.com/srd
- The conversion we pinned: https://github.com/downfallx/dnd-5e-srd-markdown (commit `1b4b99d`)
