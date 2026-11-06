# 07 — Error Case Studies

A running log of real failures in this codebase, written up properly. Not a runbook —
[06-debugging-runbook.md](./06-debugging-runbook.md) tells you what to do when a known symptom
appears. This file is for the *other* kind of failure: the one nobody had seen before, where the
interesting question is not "how do I clear it" but **"how did this reach a running browser at
all, and what class of defect does it belong to?"**

Each case answers the same seven questions: what was seen, what it actually was, why it happened,
why it survived every gate, why it matters, how it was resolved, and what changed. The last section
is a blank template — add new encounters at the top of the index and keep the numbering.

The point of this file is not to record blame. It is to convert one-off crashes into permanent
guard rails, so that the same *class* of mistake cannot ship twice.

---

## Index

| ID | Date | Title | Class | Severity |
|---|---|---|---|---|
| [ECS-001](#ecs-001--sparkles-is-not-defined--the-dangling-jsx-binding) | 2026-09-23 | `Sparkles is not defined` — the dangling JSX binding | Unbound identifier in JSX | High (route down) |

---

# ECS-001 — `Sparkles is not defined` — the dangling JSX binding

### At a glance

| | |
|---|---|
| **Reported** | 2026-09-23, dev session on `localhost:5173` |
| **Surface** | Face Learning (`/face-learning`), on opening a face crop's full-image lightbox |
| **Symptom** | Whole routed view replaced by the ErrorBoundary panel |
| **Error** | `ReferenceError: Sparkles is not defined` at `FaceLearning.jsx:767:22` |
| **Introduced** | commit `afb12ac`, 2026-09-08 — 15 days dormant |
| **Root cause** | A shared import binding was deleted while a second consumer still referenced it |
| **Class** | Unbound identifier referenced from JSX — invisible to the compiler *and* to ESLint as configured |
| **Blast radius** | ErrorBoundary sits above `<Routes>`, so a single icon took down the entire page |
| **Related finds** | Two more live instances of the same class, including an unconditional crash on a shipped page |

---

## 1. What was seen

```
ErrorBoundary.jsx:18 [ErrorBoundary] uncaught render error:
  ReferenceError: Sparkles is not defined
      at SampleImage (FaceLearning.jsx:767:22)

  at SampleImage  (.../FaceLearning.jsx:1013:24)
  at SampleCard   (.../FaceLearning.jsx:800:23)
  at FaceLearning (.../FaceLearning.jsx:131:31)
  at AppLayout / ProtectedRoute / Routes / ErrorBoundary / App / providers
```

Reading it correctly matters, because two thirds of that output is not what it looks like:

- **The first frame is real** — a genuine JS stack frame, source-mapped by Vite. Line 767, column
  22 of the actual source file.
- **Everything below is React's synthesised component stack**, not call frames. Those line numbers
  point at each component's *declaration site in the transformed module*, which is why they do not
  match the source (`FaceLearning` is declared at source line 143, not 131; `SampleImage` at 675,
  not 1013). The import block collapses under transform, pushing early declarations up; each JSX
  node then expands into a `jsx(...)` call, pushing later ones down. Use the component stack to read
  the *tree*, never to locate a line.
- **`App.jsx?t=1790080138470`** — the `?t=` is Vite's HMR cache-buster. This was a hot-reloaded dev
  session.
- **The doubled log is one fault, not two.** Between the two `ErrorBoundary.jsx:18` lines React
  prints *"React will try to recreate this component tree from scratch…"* — in development it
  deliberately re-renders the failing subtree so the error resurfaces with a clean stack.

---

## 2. What it actually was

Commit `afb12ac` (2026-09-08, "UI of AI INTELLIGENCE CHANGED…") redesigned the Face Learning page
header. Two hunks, and they are the whole story.

**Hunk A — the header icon was replaced:**

```diff
-  <span className="grid h-11 w-11 ... rounded-xl bg-slate-950 text-white shadow-sm">
-    <Sparkles className="h-5 w-5" strokeWidth={2} />
-  </span>
+  <PageIcon icon={GraduationCap} />
```

**Hunk B — the import list was updated to match:**

```diff
   ShieldCheck,
-  Sparkles,
+  GraduationCap,
   ThumbsDown,
```

That is a correct, tidy edit — **if `Sparkles` had exactly one consumer in the file.** It had two.
The second, ~490 lines below and untouched by that commit, is the Enhance-face trigger inside the
image lightbox:

```jsx
{url ? (
  <div className="absolute bottom-6 right-6">
    <EnhanceFaceDialog imageUrl={url}>
      <button type="button" className="… bg-brand …">
        <Sparkles className="h-3.5 w-3.5" />   // ← dangling reference
        Enhance face
      </button>
    </EnhanceFaceDialog>
  </div>
) : null}
```

The one-command diagnosis: `grep -n "Sparkles" FaceLearning.jsx` returned **exactly one line — the
usage, with no declaration anywhere in the file.**

> **The general shape.** An ES module import creates a binding in **module scope**. The edit that
> deletes it is **line-local**. A unified diff shows you the removed line and the usage you removed
> alongside it; it cannot show you the other consumer 490 lines away. That asymmetry is the entire
> bug class.

---

## 3. Why the toolchain could not see it

Four gates, and the defect walked through all of them.

### 3.1 The compiler is structurally incapable of catching it

JSX is sugar. esbuild rewrites

```jsx
<Sparkles className="h-3.5 w-3.5" />
```
into
```js
jsx(Sparkles, { className: "h-3.5 w-3.5" })
```

`Sparkles` becomes an ordinary **identifier lookup**, no different from a stray `foo()`. A
transpiler does not resolve identifiers across scopes — that is not its job.

Note the asymmetry that makes this specific to components: `<div>` compiles to the *string*
`"div"`, so a lowercase tag can never throw this. Only capitalised tags compile to variable
references. "Unknown component" and "typo'd HTML tag" are completely different failure modes.

### 3.2 ESLint was blind to it — verified, not assumed

Running the linter on the broken file reported three unrelated errors and **not this one**:

```
$ npx eslint src/modules/face/FaceLearning.jsx
  123:7   react-hooks/set-state-in-effect
  551:25  'Icon' is defined but never used     no-unused-vars
  685:5   react-hooks/set-state-in-effect
✖ 3 problems
```

Two independent reasons, both in `eslint.config.js` as it stood:

- **`no-undef` does not see JSX.** It was enabled (via `js.configs.recommended`), but espree's scope
  analyser does not register a `JSXIdentifier` as a variable *reference*. Catching `<Sparkles/>`
  requires `react/jsx-no-undef` from `eslint-plugin-react`, which the project did not install (only
  `react-hooks` and `react-refresh`). **The rule that would have caught this was present and
  structurally unable to see the usage.**
- **`varsIgnorePattern: '^[A-Z_]'` silenced the mirror image.** Any capitalised import that becomes
  unused is deliberately ignored — so the opposite mistake (delete the usage, leave the import) was
  equally invisible.

Both halves of an import/usage mismatch were unobservable. That is what made this a *class*, not an
incident.

### 3.3 A ternary hid it from manual testing

```jsx
{url ? ( … <Sparkles/> … ) : null}
```

Ternary branches evaluate lazily. When `url` is falsy the element is never constructed and the
dangling reference is never touched. And `url` is hard to make truthy: it is an
`URL.createObjectURL(blob)` set by an async fetch, further gated by an `IntersectionObserver`.

So on any run where snapshots are missing, slow, failing, or scrolled out of view, **the page looks
perfectly fine.** It only detonates when a card holds a real crop *and* the operator opens the
lightbox. That is why a 15-day-old commit surfaced on a random Tuesday.

### 3.4 Code review could not have caught it from the diff

In the diff, `-Sparkles,` sits directly beside `+GraduationCap,`, immediately after a hunk that
visibly removes a `<Sparkles/>`. It reads as a self-consistent swap. The second consumer appears in
no hunk. **Nothing in the reviewable diff hints that the binding had another client.** Do not file
this under "reviewer missed it."

---

## 4. Why it matters

Three reasons, in increasing order of importance.

1. **Blast radius is a whole route, not a tile.** `ErrorBoundary` is mounted above `<Routes>` in
   `App.jsx`. A missing icon inside one thumbnail escalates to the full-screen *"Something went
   wrong on this screen"* panel. For an operator console watching cameras, one unbound identifier
   in a decorative button blanks the surveillance page.
2. **Latency between cause and symptom was 15 days.** The commit that broke it and the session that
   revealed it share no context. Anyone debugging this cold would start at the Enhance button — the
   code that is innocent — because the guilty commit never touched it.
3. **It was never one bug.** The sweep below found two more live instances that nobody had
   reported, one of them an unconditional crash. Fixing only the reported symptom would have left
   those in production and guaranteed a recurrence.

---

## 5. The sweep — what else was carrying this

First attempt was a hand-rolled regex scanner (extract imports, extract capitalised JSX tags,
diff the sets). It reported **32 hits, 29 of them false positives** — `<Icon/>` from
`PageIcon({ icon: Icon })` prop renames, function parameters, and one match found *inside a
comment*. Useless.

That is the empirical argument for real scope analysis over grep. With `react/jsx-no-undef` enabled
and all 585 files linted, the true count was **3** — the known one, plus:

### 🔴 `modules/ai-feed/aifeed/ZoneEditorModal.jsx:621, 659` — unconditional crash, shipped page

Same class, different mechanism — a **destructure**, not an import:

```js
const SHAPE_TOOLS = [{ key: 'line', label: 'Line', Icon: Minus }, …];
…
{SHAPE_TOOLS.map(({ key, label }) => {     // ← Icon never destructured
   …
   <Icon className="h-4 w-4" />             // ReferenceError
```

Reached from `AiFeed.jsx:925`. Inside a `.map()` over a non-empty array with no conditional to hide
behind — it throws the moment the zone editor's Shape or Detect picker renders.

### 🟡 `ai-analytics/components/System/PersonnelSearch.jsx:187` — ECS-001 verbatim

`<EmptyState title="No personnel found" />` with the name missing from the import list, while the
sibling `System/Camera.jsx` imports it correctly from the very same `'../ui.jsx'`. Guarded by
`!loading && filtered.length === 0`, so it fires **only on an empty search result**.

---

## 6. Resolution

Two layers, deliberately. Fixing only the first guarantees a third occurrence.

### Layer 1 — the three defects

| File | Change |
|---|---|
| `smart-cam-app/src/modules/face/FaceLearning.jsx` | Restored `Sparkles,` to the lucide import, in its original pre-`afb12ac` slot |
| `smart-cam-app/src/modules/ai-feed/aifeed/ZoneEditorModal.jsx` | Destructured `Icon` in both `.map()` callbacks |
| `smart-cam-app/src/ai-analytics/components/System/PersonnelSearch.jsx` | Added `EmptyState` to the existing `'../ui.jsx'` import |

### Layer 2 — the guard rail

Installed `eslint-plugin-react@7.37.5` (devDependency) and enabled **exactly two rules** — not
`react/recommended`, which would have buried the signal under hundreds of `prop-types` errors:

```js
plugins: { react },
settings: { react: { version: 'detect' } },
rules: {
  'react/jsx-no-undef': 'error',   // the only rule that can see JSX identifiers
  'react/jsx-uses-vars': 'error',  // counterpart: marks JSX-only components as used
}
```

`jsx-uses-vars` matters as much as `jsx-no-undef`: without it, components referenced only from JSX
look unused, which is the reason `varsIgnorePattern: '^[A-Z_]'` had to exist in the first place.
With it on, that escape hatch is no longer load-bearing.

The config carries a comment naming this incident. Per the "explain the why" convention: a guard
whose failure mode is undocumented gets simplified back into an outage.

---

## 7. Verification

| Check | Result |
|---|---|
| Probe file (dangling component in a ternary + a prop-renamed `<Icon/>` + an imported `<Check/>`) | Exactly 1 error, on the right line, **0 false positives** |
| `react/jsx-no-undef` across 585 files | **0** (was 3) |
| All other rule counts | **unchanged** — the new rules added no noise |
| `npm run build` | **exit 0**, full production bundle |
| `git diff --numstat` | 5 files, 21 lines, no line-ending churn |

**Not verified:** nothing was clicked through in a browser. Given the NVR-flood history with browser
tests, driving the live app was not worth the risk for a defect that is fully decidable statically —
lint proves the binding exists, the build proves it resolves. Stated plainly so nobody later reads
more assurance into this than was earned.

---

## 8. Open item — the rail is not yet enforced

`npm run lint` currently exits 1 on ~109 pre-existing errors (34 `no-unused-vars`, 31
`react-hooks/set-state-in-effect`, 15 `no-empty`, …). **A gate that is always red gates nothing.**
Until that is triaged, this rule protects the codebase only if a human runs lint and reads the
output.

The ratchet that makes it enforceable immediately:

```js
'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]' }],  // demote the backlog
'no-empty': 'warn',
'react/jsx-no-undef': 'error',                                  // keep the crash class hard
```

…then `npm run lint` in CI or a pre-commit hook. That converts "a missing import reaches production
and takes down a route" into "the commit does not land."

---

## 9. Rules to carry forward

1. **Removing an import is not a local edit.** Before dropping a name from an import list, the
   question is never *"did I remove the usage I am editing?"* but *"does
   `grep -n '\bName\b' <file>` return zero?"*
2. **A capitalised JSX tag is a variable reference.** Anything that can be undefined at runtime —
   an import, a destructured field, a prop — can be undefined *here*, and the failure is a hard
   crash, not a missing element.
3. **Lazily-evaluated branches are where latent crashes live.** A dangling reference inside
   `cond ? … : null` will pass every smoke test until real data arrives. When the linter cannot see
   it, nothing will.
4. **Static defects deserve static proof.** A ReferenceError from a missing binding is fully
   decidable by scope analysis. Reaching for the browser here is slower *and* weaker than reaching
   for the right lint rule.
5. **A crash found is a class to sweep.** The reported bug was one of three. Always ask what else
   carries the same shape before closing.

*Written 2026-09-23 from the code and from `git log`; every claim in §3, §5 and §7 was produced by
running the tool named, not recalled.*

---
---

# Template for new entries

```markdown
# ECS-00N — <one-line title>

### At a glance
| | |
|---|---|
| **Reported** | |
| **Surface** | |
| **Symptom** | |
| **Error** | |
| **Introduced** | commit, date, days dormant |
| **Root cause** | |
| **Class** | the general shape, not this instance |
| **Blast radius** | |

## 1. What was seen
Raw log/stack, and how to read it correctly.

## 2. What it actually was
The minimal true statement of the defect. Include the diagnosing command.

## 3. Why the toolchain could not see it
Walk each gate it passed: compiler, linter, types, tests, review. Verify each claim by running it —
"the linter should have caught this" is a hypothesis until you have its output.

## 4. Why it matters
Blast radius, cause-to-symptom latency, and whether it is one bug or a class.

## 5. The sweep
What else in the repo carries the same shape. Prefer real analysis over grep, and say which you used.

## 6. Resolution
Layer 1: the defect. Layer 2: the guard rail that makes recurrence impossible. Both, always.

## 7. Verification
A table of checks actually run, with results — and an explicit list of what was NOT verified.

## 8. Open items
Anything left, especially a guard rail that exists but is not yet enforced.

## 9. Rules to carry forward
Generalisable lessons. If a lesson is only about this file, it is not a lesson.
```
