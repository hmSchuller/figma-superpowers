# Figma Superpowers

A Figma plugin that bridges your design system with AI chat assistants. Extract your component catalog, design tokens, and variable collections into structured prompts, then paste AI-generated code back into Figma to execute layout modifications.

## How It Works

1. **Scan Project Library** — Extracts components, design tokens, and variable collections into a system prompt copied to your clipboard.
2. **Paste into AI Chat** — Paste the system prompt into your preferred AI assistant (Gemini, ChatGPT, Claude, etc.), then describe a design change.
3. **Copy Design Context** — Back in Figma, select target layers and copy the selection context.
4. **Paste Generated Code** — Paste the AI's response into the plugin's paste field. It extracts JavaScript code and executes it against your Figma document.

## Project Structure

```
figma-superpowers/
├── code.js            # Plugin backend — Figma API calls, node serialization, code execution
├── ui.html            # Plugin UI — buttons, paste field, prompt assembly
├── manifest.json      # Figma plugin manifest
├── package.json       # Dev dependencies (ESLint, TypeScript, Figma typings)
├── prompts/
│   ├── system-prompt.txt       # System prompt template (source of truth)
│   └── context-capsule.txt     # Selection context template (source of truth)
└── README.md
```

## Setup

1. Download the latest release and unzip it
2. In Figma, go to **Plugins > Development > Import plugin from manifest**
3. Select the `manifest.json` file from the unzipped folder

That's it — no compilation or build step required. The plugin runs on pure JavaScript.

## Prompts

The prompts in `prompts/` use placeholder syntax for dynamic values:

| Placeholder | Description |
|---|---|
| `{{MANIFEST}}` | Component catalog JSON |
| `{{VARIABLES}}` | Design tokens JSON |
| `{{COLLECTIONS}}` | Variable collections JSON |
| `{{TARGET_DATA}}` | Selection or null |
| `{{PAGE_NAME}}` | Current Figma page name |
| `{{TARGETING_STATE}}` | `GLOBAL PAGE SCOPE` or `LOCAL SELECTION BOUNDS` |

Edit the `.txt` files to customize prompts. The plugin reads them as template constants at runtime.

## Development

The plugin is pure JavaScript — no compilation needed. Edit `code.js` or `ui.html` directly.

For linting:

```bash
npm install
npm run lint
```

## License

MIT
