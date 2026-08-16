[简体中文](README.zh.md)

# gavel-review

An adversarial, multi-perspective code review plugin. Multiple independent review perspectives (lenses) attack a code change in parallel — each perspective cares only about its own category of problems and does not interfere with the others; an arbitration layer then merges cross-lens findings, deduplicates them, grades them by severity, and outputs a report with evidence and fix suggestions. The whole process is read-only and never modifies code.

The plugin ships with a deterministic static sentinel (model-free rule scanning), suppression rules (to prevent the same class of problems from being reported repeatedly), and a review history (incremental comparison against known issues), and provides two entry points:

- **dsh (DeepSeek Harness) plugin entry**: registers the `gavel_review` tool that the model can call directly within a session;
- **Standalone CLI entry**: runs locally from the command line, compatible with any model service speaking the OpenAI Chat Completions protocol.

Zero third-party runtime dependencies (the core engine and CLI use only Node built-ins).

---

## Design philosophy

A single reviewer is easily biased by their own perspective: the person writing code cannot see their own blind spots, and generic review often mixes style issues with real defects. gavel's approach is to **split "breaking" into multiple specialized directions, attack in parallel, then merge the results**:

- Each lens carries a set of **actionable checkpoint lists** (e.g., "null and uninitialized", "injection", "complexity"); a finding must map to a concrete checkpoint, and reports can be traced back to list entries;
- Lenses fan out in parallel and do not wait for each other (which lenses are enabled is independently configurable);
- The static sentinel runs before the model as a deterministic backstop with rules, guaranteeing output even if the model fails;
- The arbitration layer clusters cross-lens findings by "file + line proximity + title token overlap"; when multiple perspectives hit the same issue it gains a **corroboration bonus**, and severity may be raised by one level;
- Severity is **computed deterministically** (impact × 2 + confidence + corroboration); the same input always yields the same verdict;
- An optional **deep review** stage challenges each candidate finding one by one; refuted findings are downgraded to "observation" rather than deleted — the decision process stays transparent.

## Review pipeline

```
Input (diff text / file path)
   │
   ▼
① Ingest collect ────── parse unified diff or read files, build line mapping
   │
   ▼
② Static sentinel tripwire ── deterministic regex rules (hardcoded credentials, dangerous calls, leftover debug ...)
   │
   ▼
③ Lens probing probe ──── correctness / security / maintainability attack in parallel (LLM calls)
   │
   ▼
④ Deep review deep (optional) ── challenge-based re-validation of candidate findings (serial)
   │
   ▼
⑤ Arbitration merge ──── cross-lens clustering, deduplication, fingerprinting, severity grading
   │
   ▼
⑥ Suppression filter suppress ── findings matching suppression rules are archived and no longer reported
   │
   ▼
⑦ Docket record docket ──── append history, mark known issues (incremental review)
   │
   ▼
Report (Markdown / JSON)
```

## Directory structure

```
adversarial-review/
├── package.json          # package manifest; dsh.bundle.patch points at the integration patch
├── cordis.patch.yml      # dsh integration patch (plugin load line + default config)
├── bin/gavel.mjs         # CLI launcher
├── src/
│   ├── index.ts          # public entry (library API + dsh plugin module exports)
│   ├── cli.ts            # standalone CLI (review / history / rules)
│   ├── core/
│   │   ├── types.ts      # domain model
│   │   ├── engine.ts     # orchestration engine (pipeline master)
│   │   ├── diff.ts       # unified diff parser
│   │   ├── tripwire.ts   # static sentinel rule engine
│   │   ├── lenses.ts     # lens registry and checkpoint lists
│   │   ├── merge.ts      # cross-lens merging, clustering, fingerprinting
│   │   ├── severity.ts   # severity grading (deterministic)
│   │   ├── suppress.ts   # suppression rules
│   │   ├── docket.ts     # review history (JSONL)
│   │   └── report.ts     # Markdown / JSON report rendering
│   ├── llm/              # model client (interface + HTTP implementation)
│   └── dsh/plugin.ts     # dsh adapter: Cordis plugin + tool registration
├── test/                 # node:test test suite (80 tests)
└── examples/             # sample diffs, rule files
```

---

## Installing in DSH

```bash
dsh plugin --profile demo add github:JohnXu22786/adversarial-review
```

This installs the published plugin and its bundle patch (see the detailed manual steps under "dsh (DeepSeek Harness) integration" below). The plugin registers the `gavel_review` tool; the model can then call it directly within a session.

## Standalone CLI usage

Requires Node.js >= 20.19 (running the source directly requires >= 23.6, see below). You can use the built artifacts without installing any dependencies:

```bash
# Build (before first use)
npm install
npm run build

# Review a diff file
node bin/gavel.mjs review --diff examples/sample.diff \
  --api-key $GAVEL_API_KEY --model deepseek-chat

# Review the most recent commit
node bin/gavel.mjs review --base HEAD~1

# Review given files (whole-file mode)
node bin/gavel.mjs review --path src/order.js --path src/notify.js

# Combined options: deep review + emit suppression rules + report files + CI gate
node bin/gavel.mjs review --diff p.patch --deep --emit-rules \
  --out report.md --json-out report.json --fail-on required

# Inspect docket and rules
node bin/gavel.mjs history --stats
node bin/gavel.mjs rules --list
```

Common options:

| Option | Description |
| --- | --- |
| `--diff <path\|->` | unified diff text file (`-` reads stdin); mutually exclusive with `--base` and `--path` |
| `--base <ref>` | run `git diff --unified=8 <ref>` (e.g. `HEAD~1`) |
| `--path <p>` | whole-file review; repeatable |
| `--lens <a,b>` | lens subset: `correctness,security,maintainability`; exits with an error on invalid ids |
| `--deep` | enable deep review (challenge-based re-validation) |
| `--emit-rules` | generate suppression rules for findings at "must fix" or above |
| `--rules <path>` | rule file (default `<history-dir>/rules.json`) |
| `--no-history` | disable docket and history comparison |
| `--history-dir <d>` | docket directory (default `.gavel/`) |
| `--out / --json-out` | Markdown / JSON report output paths |
| `--fail-on <level>` | exit code 2 if any finding reaches that level (CI gate) |
| `--model / --base-url / --api-key` | model routing; environment variables `GAVEL_MODEL` / `GAVEL_BASE_URL` / `GAVEL_API_KEY` (or `DEEPSEEK_API_KEY`) |

When the build artifacts are absent, the CLI automatically falls back to executing the TypeScript source directly under `src/` (Node >= 23.6 has built-in type stripping).

## dsh (DeepSeek Harness) integration

dsh uses an "everything is a plugin" architecture: a plugin is an npm package that declares an integration patch via the `dsh.bundle.patch` field in `package.json`; the patch inserts a plugin line into the Cordis config line list; the plugin registers capabilities in `apply(ctx, config)` with reversible effects. This plugin's dsh integration points:

- **Manifest**: `package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
- **Patch**: `cordis.patch.yml` (inserts a plugin line with id `gavel`, including default config)
- **Plugin module**: `src/dsh/plugin.ts`, named exports `name` / `inject` / `Config` / `apply` (same loading convention as dsh tool plugins: the loader takes `exports.default ?? exports`, then assembles it via `ctx.registry.plugin()`)
- **Tool interface**: inside `apply()` it registers the `gavel_review` tool via `ctx.tools.register(defineTool(...))`; the model can call it within a session without human involvement

### Manual install steps

```bash
# 1. Build artifacts (lib/)
npm install && npm run build

# 2. Integrate via dsh's plugin management command (equivalent to pnpm install + automatic bundle patch detection)
dsh plugin --profile <your profile> add <this package path or the published package name>

# 3. (Optional) override config by id in the profile's cordis.patch.yml
# override example:
# - id: gavel
#   name: 'gavel-review'
#   config:
#     deep: true
#     historyDir: .review
#     maxFindingsPerLens: 8
```

If there is no plugin management command, you can manually add the above line to the profile's `cordis.patch.yml` and add the package to the dependencies — the mechanism is the same.

### Tool interface: `gavel_review`

| Parameter | Type | Description |
| --- | --- | --- |
| `diff` | string | unified diff text (suggested `git diff --unified=8` output). At least one of `diff` / `paths` |
| `paths` | string[] | list of file paths to review (whole-file review) |
| `lenses` | string[] | lens subset (`correctness` / `security` / `maintainability`); all by default |
| `deep` | boolean | whether to deep review; defaults to the deployment config |
| `emitRules` | boolean | generate suppression rules for findings at "must fix" or above and write them to the rule file |

The tool returns canonical JSON (declared via a `{ type: 'json' }` output), whose structure is the report itself; what is rendered to the model is Markdown text. The model-facing description already states: read-only, suitable for invocation after merge/commit/refactor.

### Deployment config (`gavel` line `config`)

| Field | Default | Description |
| --- | --- | --- |
| `toolName` | `gavel_review` | name of the registered tool |
| `provider` / `model` | empty | model routing; empty falls back to the current agent, then to `deepseek-official` / `deepseek-v4-flash` |
| `lenses` | all three | enabled lenses |
| `deep` | `false` | whether deep review is the default |
| `history` | `true` | whether to write the docket and compare against history |
| `historyDir` | `.gavel` | docket and rule file directory |
| `maxCharsPerLens` | `24000` | per-lens context cap (characters) |
| `maxFindingsPerLens` | `12` | maximum findings reported per lens |
| `maxTokens` | `3000` | per-lens call output cap (tokens) |

### Runtime behavior

- Inside the tool, lens calls fan out in parallel through the injected `ctx.llm` streaming interface (Promise fan-out; a single failing lens does not take down the whole run, and failures are recorded in the report's "parse failures" section); `exec.signal` is passed through end to end, supporting session cancellation;
- The docket and rule files are written under `historyDir` (relative to the working directory); write failures do not block the review;
- Uninstalling the plugin unregisters the tool (reversible Cordis effect) with no leftover listeners.

> Version note: dsh is in developer preview and its API may evolve. This plugin is implemented against the current contract of the rc-series packages (`ctx.tools.register` + `defineTool`, `ctx.llm.stream`); if the upstream interface changes, only one file, `src/dsh/plugin.ts`, needs adjustment.
>
> Dependency note: the package root entry (`exports["."]`) also serves as the dsh plugin module and statically imports dsh ecosystem packages; therefore, **importing the root entry as a library requires installing the optional peer dependencies** (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`). The standalone CLI (`bin/gavel.mjs`) and the engine submodules do not go through the root entry and keep zero third-party runtime dependencies.

---

## Severity grading

Score = impact × 2 + confidence + corroboration bonus (+1 when multiple independent perspectives hit the same issue), capped at 10:

| Score | Level | Meaning |
| --- | --- | --- |
| 9-10 | `blocker` | fatal impact with high confidence, or corroborated by multiple perspectives |
| 7-8 | `required` | should be handled before shipping |
| 5-6 | `recommended` | should be handled soon |
| 3-4 | `optional` | handle depending on cost |
| 0-2 | `informational` | signals worth noting |

Impact/confidence are self-reported by each lens in its findings (0-3); score computation and grading are fully deterministic. Findings refuted by the deep review stage are fixed at `informational` and marked `verified: refuted`.

## Static sentinel (deterministic rules)

16 built-in rule categories, covering: hardcoded credentials, private key material, dynamic code execution, shell concatenation, SQL concatenation, empty exception handling, leftover debug, unfinished markers, broad type ignores, passwords embedded in connection strings, disabled TLS verification, destructive commands, download-and-execute, untrusted deserialization, weak random numbers in security-sensitive contexts, and debug logging. Rules are scoped by file language; hits participate in merging and grading (they can synthesize `mixed` sources with lens findings).

## Suppression rules

The rule file is JSON (default `.gavel/rules.json`):

```json
{
  "version": 1,
  "rules": [
    { "id": "r-001", "file": "src/**/*.js", "source": "any",
      "key": "console.log", "reason": "known noise", "createdAt": "2026-08-01T10:00:00Z" }
  ]
}
```

Matching: file glob (supports `**` / `*` / `?`) + source (`lens` / `tripwire` / `any`) + title keyword (case-insensitive substring). A match moves the finding from the main report into the "suppressed findings" section. `--emit-rules` auto-generates candidate rules for findings above the threshold (editable by hand), and the CLI provides `rules --list / --add / --drop` for management.

## Review history (docket)

`.gavel/docket.jsonl`, an append-only JSONL file, one review summary per line (time, scope, fingerprint set). Uses:

- Newly reported findings are compared against historical fingerprints (file + line-number bucket + title tokens); matches are marked `known` and shown in the report as "fingerprint matches a known issue in history";
- `gavel history --stats` shows run counts, level distribution, and files with the most findings.

## Development and testing

```bash
npm test          # full node:test suite (80 tests; tests run the source directly, requires Node >= 23.6)
npm run typecheck # tsc --noEmit
npm run build     # produces lib/ (run automatically via the prepare hook on npm install)
```

Code conventions: pure ESM, erasable TypeScript syntax (no enums/decorators), relative imports within source files use the `.ts` suffix (`tsc` rewrites them to `.js` at build time), so tests and the CLI can run the source directly.

## Design trade-offs and limitations

- **Report-only, never modifies**: the plugin never touches code; fix suggestions are just text.
- **The lens set is configurable but fixed**: the default three perspectives cover correctness/security/maintainability; developers can extend their own lenses and checkpoint lists in `lenses.ts`.
- **The sentinel is heuristic**: regex rules produce a small number of false positives; they start at `informational`, are graded in combination with lens findings, and can be suppressed by suppression rules.
- **Deep review adds cost**: each round of deep review is an additional serial model call; it is off by default and enabled on demand.

---

## License

MIT — see [LICENSE](LICENSE).
