# Consulting Flow Design

## Context

Figma Superpowers currently uses two prompt templates:

- `prompts/system-prompt.txt` primes an AI assistant with the scanned component catalog, design tokens, and variable collections.
- `prompts/context-capsule.txt` adds page and selection context for canvas-specific work.

The current system prompt already has a consultation mode and an execution mode, but the overall wording assumes users will append a context capsule and request a layout adjustment. This makes the plugin feel execution-first even when the scanned project library is already enough for general design-system consulting.

## Goal

After users run **Scan Project Library**, they should be able to ask general consulting questions without copying a context capsule first. The assistant should support design-system lookup, critique, planning, and recommendations from the scanned library. It should only produce executable Figma JavaScript after the user explicitly requests execution or confirms that they are ready for code.

## Prompt Architecture

The setup prompt will become the main behavioral contract. It will define three interaction modes:

1. Consultation Mode

Used for questions, ambiguity, advice, critique, catalog lookup, token/component recommendations, and implementation planning. The assistant answers from the scanned catalog first. If the catalog does not fully answer the question, it may add clearly labeled general UX or design advice. It must not output executable JavaScript code blocks in this mode.

2. Readiness Handoff

When consultation produces a recommendation that could be automated, the assistant asks once whether the user wants executable Figma code. A typical handoff is: "If you're ready, I can turn this into an executable Figma script. Should I generate the code now?"

3. Execution Mode

Used only when the user explicitly asks to generate, apply, modify, or change something in Figma, or when the user confirms the readiness handoff. This mode keeps the existing validation analysis and strict JavaScript code block requirements.

## System Prompt Changes

Update `prompts/system-prompt.txt` to:

- Change the role from an execution-heavy "Design System Expert and Figma Plugin API Code Compiler" to an "interactive Design System Consultant and Figma Plugin API Code Compiler".
- State that users may ask general design-system questions after only the library scan.
- State that a context capsule is optional and only needed for canvas-specific advice or execution.
- Expand consultation mode to cover component/token lookup, design-system recommendations, UX/layout critique, implementation planning, and ambiguity handling.
- Require consultation responses to separate catalog-backed facts from general design advice when both are used.
- Add the readiness handoff rule.
- Tighten execution mode so it triggers only for explicit execution requests or confirmed handoff.
- Require the assistant to ask for selection/page context when execution would be unsafe without it.

## Context Capsule Changes

Update `prompts/context-capsule.txt` so it no longer frames the payload only as a layout adjustment input. The final instruction should say the capsule can support canvas-specific consultation, critique, planning, or execution.

## Runtime Template Changes

The plugin currently embeds the prompt templates directly in `ui.html`. To keep runtime behavior aligned with the source prompt files, mirror the same edits into:

- `SYSTEM_PROMPT_TEMPLATE`
- `CONTEXT_CAPSULE_TEMPLATE`

No backend changes are needed. `code.js` already provides the catalog, variable, collection, page, and selection data needed for the new prompt behavior.

## Documentation Changes

Update `README.md` lightly so the workflow explains that users can ask general consulting questions after **Scan Project Library**, before copying selection context.

## Testing

Verification will be lightweight:

- Run `npm run lint` if dependencies are available.
- Inspect `prompts/system-prompt.txt` and the embedded `SYSTEM_PROMPT_TEMPLATE` in `ui.html` for matching behavior.
- Inspect `prompts/context-capsule.txt` and the embedded `CONTEXT_CAPSULE_TEMPLATE` in `ui.html` for matching behavior.
- Confirm no paste-field execution behavior changed; executable code is still extracted only from JavaScript code blocks or pasted Figma code.

## Out Of Scope

- Adding new plugin buttons or UI flows.
- Changing backend Figma serialization logic.
- Automatically choosing or copying prompts from files at runtime.
- Changing the JavaScript execution parser.
