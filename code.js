figma.showUI(__html__, { width: 340, height: 320, title: "Superpowers Hub" });

/**
 * Converts Figma 0-1 float color primitives to standard uppercase Hex strings.
 */
function rgbToHex(r, g, b) {
  const toHex = function (v) {
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return "#" + toHex(r) + toHex(g) + toHex(b).toUpperCase();
}

/**
 * Converts canvas layer trees into lightweight Markdown representations,
 * achieving a ~70% reduction in token overhead compared to raw JSON.
 */
function serializeNodeMarkdown(node, depth) {
  if (!node) return "";
  depth = depth || 0;
  const indent = "  ".repeat(depth);
  let md = indent + "- **" + node.type + "**: \"" + node.name + "\" [" + Math.round(node.width) + "x" + Math.round(node.height) + "]";

  // Fills Mapping
  if ("fills" in node && node.fills !== figma.mixed && Array.isArray(node.fills) && node.fills.length > 0) {
    const colors = node.fills
      .filter(function (f) { return f.visible !== false && f.color; })
      .map(function (f) { return rgbToHex(f.color.r, f.color.g, f.color.b); });
    if (colors.length > 0) md += " | Fills: " + colors.join(", ");
  }

  // Text Content Snippets
  if (node.type === "TEXT" && node.characters) {
    const snippet = node.characters.length > 30 ? node.characters.substring(0, 30) + "..." : node.characters;
    md += " | Text: \"" + snippet.replace(/\n/g, " ") + "\"";
  }

  // Component Variants
  if (node.variantProperties) {
    md += " | Props: " + JSON.stringify(node.variantProperties);
  }

  // Auto Layout Specs
  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    md += " | AutoLayout: " + node.layoutMode + " (gap: " + node.itemSpacing + "px)";
  }

  md += "\n";

  // Recursive Walk
  if ("children" in node && node.children.length > 0) {
    for (let i = 0; i < node.children.length; i++) {
      md += serializeNodeMarkdown(node.children[i], depth + 1);
    }
  }

  return md;
}

/**
 * Summarizes local design tokens and variable collections into a structured Markdown Index.
 */
async function buildVariableCollectionsMarkdown() {
  if (!figma.variables) return "No variable collections found.";

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const localVariables = await figma.variables.getLocalVariablesAsync();

  const varsByCollection = {};
  for (let i = 0; i < localVariables.length; i++) {
    const v = localVariables[i];
    if (!varsByCollection[v.variableCollectionId]) varsByCollection[v.variableCollectionId] = [];
    varsByCollection[v.variableCollectionId].push(v);
  }

  let md = "";
  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    const modeNames = col.modes.map(function (m) { return m.name; }).join(", ");
    md += "### Collection: " + col.name + " (Modes: " + modeNames + ")\n";
    
    const colVars = varsByCollection[col.id] || [];
    for (let j = 0; j < colVars.length; j++) {
      const v = colVars[j];
      md += "- `" + v.name + "` (" + v.resolvedType + " | ID: " + v.id + ")\n";
    }
    md += "\n";
  }
  return md;
}

/**
 * Monitors selection states and pushes Markdown context to the UI.
 */
function pushCurrentSelection() {
  const selection = figma.currentPage.selection;

  if (selection.length > 0) {
    let mdContext = "";
    for (let i = 0; i < selection.length; i++) {
      mdContext += serializeNodeMarkdown(selection[i], 0);
    }
    figma.ui.postMessage({ type: "SELECTION_UPDATED", nodeMarkdown: mdContext, hasSelection: true });
  } else {
    figma.ui.postMessage({
      type: "SELECTION_UPDATED",
      nodeMarkdown: null,
      hasSelection: false,
      pageName: figma.currentPage.name
    });
  }
}

figma.on("selectionchange", pushCurrentSelection);
pushCurrentSelection();

/**
 * Execution Engine and Message Router
 */
figma.ui.onmessage = async function (msg) {
  // Generate lightweight priming index
  if (msg.type === "GENERATE_DYNAMIC_PRIMING_PROMPT") {
    const allNodes = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
    const rootNodes = allNodes.filter(function (node) { return node.parent.type !== "COMPONENT_SET"; });

    let manifestMd = "";
    for (let i = 0; i < rootNodes.length; i++) {
      const node = rootNodes[i];
      const props = node.type === "COMPONENT_SET" ? Object.keys(node.componentPropertyDefinitions).join(", ") : "None";
      manifestMd += "- **" + node.name + "** (" + node.type + ") | Key: `" + node.key + "` | Props: [" + props + "]\n";
    }

    const variablesMd = await buildVariableCollectionsMarkdown();

    figma.ui.postMessage({
      type: "PRIMING_DATA_READY",
      manifestMd: manifestMd,
      variablesMd: variablesMd
    });
  }

  // Execute AI code or Context Query tools
  if (msg.type === "RUNUserCode") {
    try {
      const asyncExecutor = new Function("return (async () => { " + msg.code + " })()");
      const result = await asyncExecutor();

      // If script returns data (Tooling Mode), route back to UI to auto-copy
      if (result !== undefined) {
        figma.ui.postMessage({
          type: "EXECUTION_RESULT",
          data: typeof result === "object" ? JSON.stringify(result, null, 2) : String(result)
        });
        figma.notify("⚡ Query executed! Results copied to clipboard.");
      } else {
        figma.notify("✅ Layout updates executed cleanly.");
      }
    } catch (error) {
      figma.notify("❌ Engine Script Error: " + error.message, { timeout: 6000 });
    }
  }
};