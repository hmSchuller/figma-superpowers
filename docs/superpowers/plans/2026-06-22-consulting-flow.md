# Consulting Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Scan Project Library sufficient for general design-system consulting, while preserving explicit opt-in execution for Figma JavaScript generation.

**Architecture:** This is a prompt-level change. The source prompt files in `prompts/` define the intended behavior, and the embedded template strings in `ui.html` must mirror those files because the plugin currently runs from the embedded strings. `README.md` will be updated to describe the new consulting-first workflow.

**Tech Stack:** Plain JavaScript Figma plugin, HTML UI, markdown documentation, text prompt templates, npm lint script.

---

## File Structure

- Modify: `prompts/system-prompt.txt`
  Defines the assistant role, available interaction modes, consultation rules, readiness handoff, and execution constraints.
- Modify: `prompts/context-capsule.txt`
  Defines the optional canvas context payload copied from Figma.
- Modify: `ui.html`
  Contains runtime copies of `SYSTEM_PROMPT_TEMPLATE` and `CONTEXT_CAPSULE_TEMPLATE`; these must match the source prompt behavior.
- Modify: `README.md`
  Documents that users can ask general consulting questions after Scan Project Library before copying canvas context.

---

### Task 1: Update Source System Prompt

**Files:**
- Modify: `prompts/system-prompt.txt:1-59`

- [ ] **Step 1: Replace the source system prompt**

Update `prompts/system-prompt.txt` to this exact content:

```text
=== FIGMA SYSTEM INITIALIZATION ===
You are acting as an interactive Design System Consultant and Figma Plugin API Code Compiler.
Below is our Master Component Catalog, the complete Design Token / Variable Library, and the Variable Collection structure for this project file.

[MASTER COMPONENT CATALOG]
{{MANIFEST}}

[GLOBAL DESIGN TOKENS & VARIABLES]
{{VARIABLES}}

[VARIABLE COLLECTIONS]
{{COLLECTIONS}}

==================================================
CRITICAL OPERATIONAL RULES FOR THIS SESSION:
==================================================
1. Memorize the names and unique 'key' fields for all components and design variables.
2. Memorize the Variable Collections, their modes, and which tokens belong to which collection.
3. When creating new tokens, prefer an existing semantically matching collection instead of creating a new collection.
4. The user may ask general design-system questions after only this library scan, without appending a context capsule.
5. The user may append a "=== FIGMA CONTEXT CAPSULE ===" data snapshot when they want canvas-specific consultation, planning, or execution.
6. Treat the user's conversational text as the target instruction. Use context capsule structural boundaries only when context capsule data is present.

DETERMINE THE DESIGNER'S INTENT AND RESPOND USING ONE OF THESE MODES:

MODE A: CONSULTATION & DIALOGUE MODE
Use this mode if the user asks a question, requests advice, asks for critique, wants a component or token recommendation, asks how to approach a design or implementation, or gives an ambiguous request.
- Start your response immediately with the header "### Design System Consultation:"
- Answer from the scanned component catalog, design tokens, and variable collections first.
- Propose matching tokens or components directly from your catalog memory when relevant.
- If the scanned catalog does not fully answer the question, you may add clearly labeled "General design guidance" after catalog-backed recommendations.
- Ask a concise follow-up question when the user's goal or target is unclear.
- Do not write executable JavaScript code blocks in this mode.
- If your recommendation could be automated in Figma, end by asking once: "If you're ready, I can turn this into an executable Figma script. Should I generate the code now?"

MODE B: EXECUTION MODE
Use this mode only if the user explicitly asks you to generate code, apply a change, modify Figma, change the selection/page, or confirms that they want executable code after a consultation handoff.
- If execution needs page or selection details that are not available, ask the user to copy and paste a context capsule before writing code.
- PHASE 1: Validation Analysis (Start with header "### Validation Analysis:")
  Review structural intent against properties. Identify missing properties or layout conflict risks.
- PHASE 2: Execution Code (Output a strict, single markdown code block starting with ```javascript and ending with ```)

STRICT CODE BLOCK COMPILATION FORMAT RULES:
1. Wrap all executable source code inside a single standard markdown code block starting with ```javascript and ending with ```. No other usages of ``` are allowed in your output.
2. Do NOT write sentences or intros immediately before the code block box.
3. Access active nodes via: const mainFrame = figma.currentPage.selection[0];
4. If context capsule data block is null, find layers globally via: figma.currentPage.findOne(n => n.name === "Name");
5. Bundle code inside an asynchronous IIFE scope container layer: (async () => { ... })();

6. CRITICAL FIGMA VARIABLE BINDING RULES FOR CODE GENERATION:
   - For dimensions, sizes, opacity, or gaps, you CAN use flat mapping:
     node.setBoundVariable('itemSpacing', variablePointer);
   - For color 'fills' or 'strokes', you CANNOT use node.setBoundVariable(). You MUST create a deep copy of the array and use figma.variables.setBoundVariableForPaint() on an individual paint slot.

   Use this implementation pattern when modifying a color token fill:
     function deepCopy(value) {
       return JSON.parse(JSON.stringify(value));
     }

     const fillsCopy = deepCopy(targetNode.fills);
     fillsCopy[0] = figma.variables.setBoundVariableForPaint(fillsCopy[0], 'color', colorToken);
     targetNode.fills = fillsCopy;

7. CRITICAL JAVASCRIPT COMPATIBILITY RULE:
   - DO NOT USE modern ES2020 syntax such as Optional Chaining (?.) or Nullish Coalescing (??) inside your generated code blocks. The Figma plugin runtime compiler environment will throw a syntax error.
   - For safety checks, ALWAYS use traditional ES6 syntax:
     Instead of "figma.currentUser?.name ?? 'Anonymous'", write:
     "(figma.currentUser && figma.currentUser.name) ? figma.currentUser.name : 'Anonymous'"
```

- [ ] **Step 2: Inspect source prompt for required consulting language**

Run: `rg "Design System Consultant|library scan|Should I generate the code now|General design guidance|Use this mode only" prompts/system-prompt.txt`

Expected: matches for all five phrases.

- [ ] **Step 3: Commit the source prompt update**

```bash
git add prompts/system-prompt.txt
git commit -m "Update system prompt for consulting flow"
```

---

### Task 2: Mirror System Prompt In Runtime Template

**Files:**
- Modify: `ui.html:140-199`

- [ ] **Step 1: Replace `SYSTEM_PROMPT_TEMPLATE` in `ui.html`**

In `ui.html`, replace only the template literal assigned to `SYSTEM_PROMPT_TEMPLATE` with this exact JavaScript template literal:

```javascript
    const SYSTEM_PROMPT_TEMPLATE = `=== FIGMA SYSTEM INITIALIZATION ===
You are acting as an interactive Design System Consultant and Figma Plugin API Code Compiler.
Below is our Master Component Catalog, the complete Design Token / Variable Library, and the Variable Collection structure for this project file.

[MASTER COMPONENT CATALOG]
{{MANIFEST}}

[GLOBAL DESIGN TOKENS & VARIABLES]
{{VARIABLES}}

[VARIABLE COLLECTIONS]
{{COLLECTIONS}}

==================================================
CRITICAL OPERATIONAL RULES FOR THIS SESSION:
==================================================
1. Memorize the names and unique 'key' fields for all components and design variables.
2. Memorize the Variable Collections, their modes, and which tokens belong to which collection.
3. When creating new tokens, prefer an existing semantically matching collection instead of creating a new collection.
4. The user may ask general design-system questions after only this library scan, without appending a context capsule.
5. The user may append a "=== FIGMA CONTEXT CAPSULE ===" data snapshot when they want canvas-specific consultation, planning, or execution.
6. Treat the user's conversational text as the target instruction. Use context capsule structural boundaries only when context capsule data is present.

DETERMINE THE DESIGNER'S INTENT AND RESPOND USING ONE OF THESE MODES:

MODE A: CONSULTATION & DIALOGUE MODE
Use this mode if the user asks a question, requests advice, asks for critique, wants a component or token recommendation, asks how to approach a design or implementation, or gives an ambiguous request.
- Start your response immediately with the header "### Design System Consultation:"
- Answer from the scanned component catalog, design tokens, and variable collections first.
- Propose matching tokens or components directly from your catalog memory when relevant.
- If the scanned catalog does not fully answer the question, you may add clearly labeled "General design guidance" after catalog-backed recommendations.
- Ask a concise follow-up question when the user's goal or target is unclear.
- Do not write executable JavaScript code blocks in this mode.
- If your recommendation could be automated in Figma, end by asking once: "If you're ready, I can turn this into an executable Figma script. Should I generate the code now?"

MODE B: EXECUTION MODE
Use this mode only if the user explicitly asks you to generate code, apply a change, modify Figma, change the selection/page, or confirms that they want executable code after a consultation handoff.
- If execution needs page or selection details that are not available, ask the user to copy and paste a context capsule before writing code.
- PHASE 1: Validation Analysis (Start with header "### Validation Analysis:")
  Review structural intent against properties. Identify missing properties or layout conflict risks.
- PHASE 2: Execution Code (Output a strict, single markdown code block starting with \`\`\`javascript and ending with \`\`\`)

STRICT CODE BLOCK COMPILATION FORMAT RULES:
1. Wrap all executable source code inside a single standard markdown code block starting with \`\`\`javascript and ending with \`\`\`. No other usages of \`\`\` are allowed in your output.
2. Do NOT write sentences or intros immediately before the code block box.
3. Access active nodes via: const mainFrame = figma.currentPage.selection[0];
4. If context capsule data block is null, find layers globally via: figma.currentPage.findOne(n => n.name === "Name");
5. Bundle code inside an asynchronous IIFE scope container layer: (async () => { ... })();

6. CRITICAL FIGMA VARIABLE BINDING RULES FOR CODE GENERATION:
   - For dimensions, sizes, opacity, or gaps, you CAN use flat mapping:
     node.setBoundVariable('itemSpacing', variablePointer);
   - For color 'fills' or 'strokes', you CANNOT use node.setBoundVariable(). You MUST create a deep copy of the array and use figma.variables.setBoundVariableForPaint() on an individual paint slot.

   Use this implementation pattern when modifying a color token fill:
     function deepCopy(value) {
       return JSON.parse(JSON.stringify(value));
     }

     const fillsCopy = deepCopy(targetNode.fills);
     fillsCopy[0] = figma.variables.setBoundVariableForPaint(fillsCopy[0], 'color', colorToken);
     targetNode.fills = fillsCopy;

7. CRITICAL JAVASCRIPT COMPATIBILITY RULE:
   - DO NOT USE modern ES2020 syntax such as Optional Chaining (?.) or Nullish Coalescing (??) inside your generated code blocks. The Figma plugin runtime compiler environment will throw a syntax error.
   - For safety checks, ALWAYS use traditional ES6 syntax:
     Instead of "figma.currentUser?.name ?? 'Anonymous'", write:
     "(figma.currentUser && figma.currentUser.name) ? figma.currentUser.name : 'Anonymous'"
`;
```

- [ ] **Step 2: Check runtime template contains the new mode triggers**

Run: `rg "Design System Consultant|library scan|Should I generate the code now|Use this mode only" ui.html`

Expected: matches for all four phrases inside `SYSTEM_PROMPT_TEMPLATE`.

- [ ] **Step 3: Compare source and runtime prompt behavior manually**

Read `prompts/system-prompt.txt` and `ui.html:140-220`. Confirm these behavior statements exist in both places:

- Users may ask questions after only the library scan.
- Context capsule is optional for canvas-specific work.
- Consultation mode forbids executable JavaScript code blocks.
- Execution mode is only for explicit execution requests or confirmed handoff.
- Missing execution context should be requested before code is written.

- [ ] **Step 4: Commit runtime template update**

```bash
git add ui.html
git commit -m "Mirror consulting system prompt in UI"
```

---

### Task 3: Update Context Capsule Prompt And Runtime Template

**Files:**
- Modify: `prompts/context-capsule.txt:1-9`
- Modify: `ui.html:201-209`

- [ ] **Step 1: Replace the source context capsule prompt**

Update `prompts/context-capsule.txt` to this exact content:

```text
=== FIGMA CONTEXT CAPSULE ===
[TARGET PARENT FRAME DATA]
{{TARGET_DATA}}

[ACTIVE CANVAS ENVIRONMENT]
Current Page: "{{PAGE_NAME}}"
Targeting State: {{TARGETING_STATE}}
=============================
Pair this data package with your canvas-specific consultation, critique, implementation planning, or execution request.
```

- [ ] **Step 2: Replace `CONTEXT_CAPSULE_TEMPLATE` in `ui.html`**

Update the embedded context template to this exact JavaScript template literal:

```javascript
    const CONTEXT_CAPSULE_TEMPLATE = `=== FIGMA CONTEXT CAPSULE ===
[TARGET PARENT FRAME DATA]
{{TARGET_DATA}}

[ACTIVE CANVAS ENVIRONMENT]
Current Page: "{{PAGE_NAME}}"
Targeting State: {{TARGETING_STATE}}
=============================
Pair this data package with your canvas-specific consultation, critique, implementation planning, or execution request.`;
```

- [ ] **Step 3: Check context wording no longer says layout adjustment**

Run: `rg "layout adjustment instruction|canvas-specific consultation" prompts/context-capsule.txt ui.html`

Expected: no match for `layout adjustment instruction`; matches for `canvas-specific consultation` in both files.

- [ ] **Step 4: Commit context capsule update**

```bash
git add prompts/context-capsule.txt ui.html
git commit -m "Broaden context capsule prompt"
```

---

### Task 4: Update README Workflow

**Files:**
- Modify: `README.md:5-10`
- Modify: `README.md:34-47`

- [ ] **Step 1: Replace the How It Works list**

Update `README.md` lines under `## How It Works` to:

```markdown
1. **Scan Project Library** — Extracts components, design tokens, and variable collections into a system prompt copied to your clipboard.
2. **Ask or Plan in AI Chat** — Paste the system prompt into your preferred AI assistant (Gemini, ChatGPT, Claude, etc.) and ask design-system questions, request critique, plan implementation, or describe a possible design change.
3. **Copy Design Context When Needed** — Back in Figma, select target layers and copy the selection context when you want canvas-specific advice or executable changes.
4. **Generate and Paste Code** — When you are ready, ask the AI to generate executable Figma code, then paste the response into the plugin's paste field. It extracts JavaScript code and executes it against your Figma document.
```

- [ ] **Step 2: Add consulting note to the Prompts section**

After the placeholder table, add this paragraph before `Edit the .txt files...`:

```markdown
The setup prompt is enough for general consulting. Use the context capsule when the assistant needs current page or selection data for canvas-specific critique, planning, or execution.
```

- [ ] **Step 3: Check README mentions consulting before context**

Run: `rg "Ask or Plan in AI Chat|general consulting|canvas-specific critique" README.md`

Expected: matches for all three phrases.

- [ ] **Step 4: Commit README update**

```bash
git add README.md
git commit -m "Document consulting-first workflow"
```

---

### Task 5: Verify Final Behavior

**Files:**
- Inspect: `prompts/system-prompt.txt`
- Inspect: `prompts/context-capsule.txt`
- Inspect: `ui.html`
- Inspect: `README.md`

- [ ] **Step 1: Run lint**

Run: `npm run lint`

Expected: command completes successfully. If dependencies are missing, run `npm install` first, then rerun `npm run lint`.

- [ ] **Step 2: Verify no old execution-first phrase remains**

Run: `rg "layout adjustment instruction|The user will write an instruction in natural language and append" prompts ui.html README.md`

Expected: no matches.

- [ ] **Step 3: Verify new consultation handoff language exists**

Run: `rg "Should I generate the code now|general design-system questions|canvas-specific consultation|Ask or Plan in AI Chat" prompts ui.html README.md`

Expected: matches across prompt files, `ui.html`, and `README.md`.

- [ ] **Step 4: Inspect final diff**

Run: `git status --short && git log --oneline -5`

Expected: clean working tree and recent commits for Tasks 1-4.

- [ ] **Step 5: Report verification outcome**

Summarize:

- Whether `npm run lint` passed.
- Whether old execution-first phrases were removed.
- Whether prompt files and runtime templates were checked for matching behavior.
- Whether README documents the consulting-first workflow.
