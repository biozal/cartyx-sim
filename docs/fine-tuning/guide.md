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
