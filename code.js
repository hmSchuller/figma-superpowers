figma.showUI(__html__, { width: 240, height: 340, title: "Superpowers Hub" });

const SAFETY_LIMITS = {
  MAX_PAGES: 8,
  MAX_COMPONENTS: 150,
  MAX_VARIABLES: 300
};

function rgbToHex(r, g, b) {
  const toHex = function (v) {
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return "#" + toHex(r) + toHex(g) + toHex(b).toUpperCase();
}

function serializeNodeMarkdown(node, depth) {
  if (!node) return "";
  depth = depth || 0;
  const indent = "  ".repeat(depth);
  let md = indent + "- **" + node.type + "**: \"" + node.name + "\" [" + Math.round(node.width) + "x" + Math.round(node.height) + "]";

  if ("fills" in node && node.fills !== figma.mixed && Array.isArray(node.fills) && node.fills.length > 0) {
    const colors = node.fills
      .filter(function (f) { return f.visible !== false && f.color; })
      .map(function (f) { return rgbToHex(f.color.r, f.color.g, f.color.b); });
    if (colors.length > 0) md += " | Fills: " + colors.join(", ");
  }

  if (node.type === "TEXT" && node.characters) {
    const snippet = node.characters.length > 30 ? node.characters.substring(0, 30) + "..." : node.characters;
    md += " | Text: \"" + snippet.replace(/\n/g, " ") + "\"";
  }

  if (node.variantProperties) {
    md += " | Props: " + JSON.stringify(node.variantProperties);
  }

  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    md += " | AutoLayout: " + node.layoutMode + " (gap: " + node.itemSpacing + "px)";
  }

  md += "\n";

  if ("children" in node && node.children.length > 0) {
    for (let i = 0; i < node.children.length; i++) {
      md += serializeNodeMarkdown(node.children[i], depth + 1);
    }
  }

  return md;
}

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

figma.ui.onmessage = async function (msg) {
  // PRE-FLIGHT CHECK & CONDITIONAL INDEXING
  if (msg.type === "GENERATE_DYNAMIC_PRIMING_PROMPT") {
    const pageCount = figma.root.children.length;
    let isHugeFile = pageCount > SAFETY_LIMITS.MAX_PAGES;
    let localVariables = [];

    if (!isHugeFile && figma.variables) {
      localVariables = await figma.variables.getLocalVariablesAsync();
      if (localVariables.length > SAFETY_LIMITS.MAX_VARIABLES) {
        isHugeFile = true;
      }
    }

    if (isHugeFile) {
      const pageNames = figma.root.children.map(function (p) { return p.name; });
      let collectionsSummary = [];

      if (figma.variables) {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        collectionsSummary = collections.map(function (c) { return c.name + " (" + c.modes.length + " modes)"; });
      }

      figma.ui.postMessage({
        type: "PRIMING_DATA_READY",
        mode: "EXPLORATIVE",
        pageNames: pageNames,
        collectionsSummary: collectionsSummary
      });
      return;
    }

    const pageNodes = figma.currentPage.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
    const rootNodes = pageNodes.filter(function (node) { return node.parent.type !== "COMPONENT_SET"; });

    let manifestMd = "";
    for (let i = 0; i < rootNodes.length; i++) {
      const node = rootNodes[i];
      const props = node.type === "COMPONENT_SET" ? Object.keys(node.componentPropertyDefinitions).join(", ") : "None";
      manifestMd += "- **" + node.name + "** (" + node.type + ") | Key: `" + node.key + "` | Props: [" + props + "]\n";
    }

    let variablesMd = "";
    if (figma.variables) {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      for (let i = 0; i < collections.length; i++) {
        variablesMd += "- Collection: **" + collections[i].name + "** (" + collections[i].modes.length + " modes)\n";
      }
    }

    figma.ui.postMessage({
      type: "PRIMING_DATA_READY",
      mode: "STANDARD",
      manifestMd: manifestMd,
      variablesMd: variablesMd
    });
  }

  // EXECUTION ENGINE
  if (msg.type === "RUNUserCode") {
    try {
      const asyncExecutor = new Function("return (async () => { " + msg.code + " })()");
      const result = await asyncExecutor();

      if (result !== undefined) {
        figma.ui.postMessage({
          type: "EXECUTION_RESULT",
          data: typeof result === "object" ? JSON.stringify(result, null, 2) : String(result)
        });
        figma.notify("📋 [READ-ONLY] Output copied to clipboard.");
      } else {
        figma.notify("✅ [WRITE/MUTATION] Canvas updated cleanly.");
      }
    } catch (error) {
      figma.notify("❌ Script Execution Error: " + error.message, { timeout: 6000 });
    }
  }
};