---
name: godot-task
description: |
  Execute a single Godot development task — generate scenes and/or scripts, verify visually.
context: fork
---

# Godot Task Executor

All files below are in `${SKILL_DIR}/`. Load progressively — read each file when its phase begins, not upfront.

| File | Purpose | When to read |
|------|---------|--------------|
| `quirks.md` | Known Godot gotchas and workarounds | Before writing any code |
| `gdscript.md` | GDScript syntax reference | Before writing any code |
| `asset-analysis.md` | Slicing sprite sheets & detecting animations | Before generating scenes with visuals |
| `scene-generation.md` | Building `.tscn` files via headless GDScript builders | Targets include `.tscn` |
| `script-generation.md` | Writing runtime `.gd` scripts for node behavior | Targets include `.gd` |
| `coordination.md` | Ordering scene + script generation | Targets include both `.tscn` and `.gd` |
| `doc_api/_common.md` | Index of ~128 common Godot classes (one-line each) | Need API ref; scan to find class names |
| `doc_api/_other.md` | Index of ~732 remaining Godot classes | Need API ref; class isn't in `_common.md` |
| `doc_api/{ClassName}.md` | Full API reference for a single Godot class | **DO NOT read full file for large classes.** Use `grep_search` to find method/prop signatures first. |

Execute a single development task from PLAN.md:

$ARGUMENTS

## Workflow

## Game Development Rules

- Build user-facing playable phases, not private test harnesses.
- Do not create `test` folders, `test_scene.tscn`, `ai_test_scene.tscn`, `*_test.gd`, debug-only menu buttons, or sample scenes for AI validation.
- Validate the official game scenes/scripts directly with Godot headless checks and static inspection.
- Phase 1 for a new game must be immediately playable from `run/main_scene`: valid main scene, visible player, camera, controls, at least one threat/objective, and no required editor setup.
- Before reporting a phase complete, confirm scripts are mounted, exported PackedScene dependencies are assigned, required groups are set, and the main scene path is valid.

1. **Analyze the task** — read the task's **Targets** to determine what to generate:
   - `scenes/*.tscn` targets → generate scene builder(s)
   - `scripts/*.gd` targets → generate runtime script(s)
   - Both → generate scenes FIRST, then scripts (scenes create nodes that scripts attach to)
2. **Asset Discovery & Manifest Generation** — this is a MANDATORY pre-step before any scene generation. Read `asset-analysis.md` for the full workflow.
   - **Step 2a: Discover** — scan `asset/`, `assets/`, `images/` for all image files (PNG, JPG, WebP).
   - **Step 2b: Analyze** — for each sprite sheet, call `analyze_image` to determine grid dimensions, frame size, and animation sequences. If `analyze_image` is unavailable, use filename heuristics (see `asset-analysis.md`).
   - **Step 2c: Write Manifest** — write analysis results to `assets/sprite_manifest.json`. This JSON is the **single source of truth** for all sprite slicing. See schema in `asset-analysis.md`.
   - **Step 2d: STOP & Ask User to Verify** — the manifest MUST be reviewed by the user before code generation. The user may correct animation names, frame counts, or fps. This is a **mandatory pause point**.
   - **VISUAL VISIBILITY RULE**: Every entity (Player, Enemy, Prop) MUST be visible in the scene. If no sprites/assets are available, you MUST add a `ColorRect` or `Polygon2D` as a temporary visual. NEVER leave a scene with only logic nodes and empty visual slots.
3. **Import assets** — call `godot_import` to generate `.import` files for any new textures, GLBs, or resources. Without this, `load()` fails with "No loader found" errors. Re-run after modifying existing assets.
4. **Generate scene(s)** — write GDScript scene builder, compile to produce `.tscn`
5. **Generate script(s)** — write `.gd` files to `scripts/`
6. **Pre-validate scripts** — catch compilation errors early before full project validation. For each newly written or modified `.gd` file, call `godot_validate` and filter the returned `errors[]` for entries matching that file's path.
7. **Validate project** — call `godot_validate` to parse-check all project scripts. **This is the primary quality gate.**
8. **Fix errors** — if Godot reports errors, read output, fix files, re-run. Repeat until clean.
9. **Verify** — analyze the validation logs and any generated files to ensure:
   - **Task goal:** does the code/scene structure match the requirements?
   - **Logic & quality:** look for obvious bugs or anti-patterns in the generated GDScript.
   If any check fails, identify the issue, fix scene/script, and repeat from step 4.
10. **Store evidence** — record the final file paths and key implementation details before reporting completion.

## Iteration Tracking & Phased Pausing

Steps 4-9 form an **implement → validate → verify** loop.

**CRITICAL RULE: DO NOT loop indefinitely on complex tasks.** 
You MUST execute work in **logical phases**. After you complete a functional chunk (e.g., scaffolding a scene, or implementing a base class):
1. **STOP calling tools.**
2. Output a plain text message to the user.
3. Include the following sections in your message:
   - **Modified files:** List of all files created or updated.
   - **Phase Summary:** Brief summary of what was built.
   - **Play Instructions:** Explicitly ask the user to run the official main scene or open the relevant production scene in Godot to verify your work.
4. **Wait for user approval** ("ok", "continue") before starting the next phase.

**MVP & Architecture Rule (Anti-Overengineering):**
- **CORE FIRST**: Focus exclusively on core gameplay loops and visual feedback in early phases.
- **NO GHOST SCRIPTS**: Do not create placeholder scripts for systems (e.g., "WeatherSystem", "AchievementSystem") unless they are actively being integrated into the current scene in this phase. 
- **SHOW, DON'T JUST HIDE**: Ensure the user can *see* and *play* the change. A purely "backend" logic change is discouraged unless it fixes a reported bug.

**Handling User Feedback (Runtime Errors):**
If the user replies with a block of text containing `Error`, `Stack Trace`, or mentions a crash/bug, this is a **Runtime Error** from the Godot Engine.
- DO NOT start new features.
- IMMEDIATELY use `grep_search` to find the failing script or variable.
- Fix the bug, call `godot_validate`, and ask the user to play the official scene again.

## Validation Tools

Use these tools instead of raw shell commands — they auto-resolve the Godot executable (no PATH setup required):

| Tool | Args | Purpose |
|------|------|---------|
| `godot_import` | — | Import new/modified assets — run before scene builders |
| `godot_run_script` | `script_path` (relative to project root) | Compile a scene builder → produces `.tscn` |
| `godot_validate` | — | Parse-check all project scripts — **primary quality gate** |
| `godot_find_executable` | — | Debug: show which Godot binary was found and how |

If `godot_find_executable` returns `ok: false`, report the error message to the user and stop — do not attempt further headless operations.

**Structured error recovery:** When a compilation error is caught:
1. Parse the error — extract the file path, line number, and error type from Godot's output
2. Look up the class — if the error mentions an unknown method or property, read `doc_api/{ClassName}.md` for the class involved
3. Check quirks — cross-reference against `quirks.md` for known patterns (`:=` with `instantiate()`, polymorphic math functions, Camera2D `current`, etc.)
4. Fix and re-validate — edit the specific file, then re-run the pre-validation step on that file only before proceeding

**Error handling:** Parse Godot's stderr/stdout for error lines. Common issues:
- `Parser Error` — syntax error in GDScript, fix the line indicated
- `Invalid call` / `method not found` — wrong node type or API usage, look up the class in `doc_api`
- `Cannot infer type` — `:=` used with `instantiate()` or polymorphic math functions, see type inference rules
- Script hangs — missing `quit()` call in scene builder; kill the process and add `quit()`

## Project Memory

Read `MEMORY.md` before starting work — it contains discoveries from previous tasks (workarounds, Godot quirks, asset details, architectural decisions). After completing your task, write back anything useful you learned: what worked, what failed, technical specifics others will need.
