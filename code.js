// Launch the minimalist 3-button plugin interface panel
figma.showUI(__html__, { width: 340, height: 300, title: "Superpowers Hub" });

/**
 * Recursively extracts structural blueprint metrics and visual token mapping data
 * from a given layer node without bloating the context capsule payload.
 */
function serializeNodeDeep(node) {
  if (!node) return null;

  // Base structural identification properties
  const result = {
    id: node.id,
    name: node.name,
    type: node.type,
    width: node.width,
    height: node.height
  };

  // 1. Visual Style Paint Mapping (Fills)
  if ("fills" in node && node.fills !== figma.mixed && node.fills.length > 0) {
    result.fills = node.fills.map(function (paint) {
      return {
        type: paint.type,
        visible: paint.visible !== false,
        opacity: paint.opacity !== undefined ? paint.opacity : 1,
        color: paint.color ? { r: paint.color.r, g: paint.color.g, b: paint.color.b } : undefined,
        gradientStops: paint.gradientStops
          ? paint.gradientStops.map(function (stop) {
              return { position: stop.position, color: stop.color };
            })
          : undefined
      };
    });
  }

  // 2. Visual Style Paint Mapping (Strokes)
  if ("strokes" in node && node.strokes !== figma.mixed && node.strokes.length > 0) {
    result.strokes = node.strokes.map(function (paint) {
      return {
        type: paint.type,
        visible: paint.visible !== false,
        opacity: paint.opacity !== undefined ? paint.opacity : 1,
        color: paint.color ? { r: paint.color.r, g: paint.color.g, b: paint.color.b } : undefined
      };
    });
    result.strokeWeight = node.strokeWeight;
    result.strokeAlign = node.strokeAlign;
  }

  // 3. Dimensional Styles (Corner Radius)
  if ("cornerRadius" in node && node.cornerRadius !== figma.mixed && node.cornerRadius > 0) {
    result.cornerRadius = node.cornerRadius;
  }

  // 4. Content Parameters (Text Values)
  if (node.type === "TEXT") {
    result.characters = node.characters;
  }

  // 5. Component Instance Parameter Maps
  if (node.variantProperties) {
    result.variantProperties = node.variantProperties;
  }

  if (node.type === "COMPONENT_SET" && node.componentPropertyDefinitions) {
    result.componentPropertyDefinitions = node.componentPropertyDefinitions;
  }

  // 6. Structural Containers (Auto Layout Layout Specs)
  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    result.autoLayout = {
      direction: node.layoutMode,
      gap: node.itemSpacing,
      padding: {
        top: node.paddingTop,
        right: node.paddingRight,
        bottom: node.paddingBottom,
        left: node.paddingLeft
      },
      primaryAlign: node.primaryAxisAlignItems,
      counterAlign: node.counterAxisAlignItems
    };
  }

  // 7. Recursive Deep Child Architecture Traversal Walk
  if ("children" in node && node.children.length > 0) {
    result.children = node.children.map(function (child) {
      return serializeNodeDeep(child);
    });
  }

  return result;
}

/**
 * Serializes a variable value so it can safely be included in the prompt payload.
 * Supports primitive variable values and alias values.
 */
function serializeVariableValue(value) {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "object") {
    const serialized = {};

    if (value.type) {
      serialized.type = value.type;
    }

    if (value.id) {
      serialized.id = value.id;
    }

    if (value.r !== undefined && value.g !== undefined && value.b !== undefined) {
      serialized.r = value.r;
      serialized.g = value.g;
      serialized.b = value.b;
      serialized.a = value.a !== undefined ? value.a : 1;
    }

    return serialized;
  }

  return String(value);
}

/**
 * Builds a compact but useful variable collection manifest.
 * This helps the prompt understand collection names, modes, token ownership,
 * mode values, and whether a token is an alias.
 */
async function buildVariableCollectionsLibrary() {
  if (!figma.variables) {
    return [];
  }

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const localVariables = await figma.variables.getLocalVariablesAsync();

  const variablesByCollectionId = {};

  for (let i = 0; i < localVariables.length; i++) {
    const variable = localVariables[i];

    if (!variablesByCollectionId[variable.variableCollectionId]) {
      variablesByCollectionId[variable.variableCollectionId] = [];
    }

    variablesByCollectionId[variable.variableCollectionId].push(variable);
  }

  const collectionsLibrary = [];

  for (let i = 0; i < collections.length; i++) {
    const collection = collections[i];
    const collectionVariables = variablesByCollectionId[collection.id] || [];

    const modes = collection.modes.map(function (mode) {
      return {
        name: mode.name,
        modeId: mode.modeId
      };
    });

    const modeNameById = {};

    for (let modeIndex = 0; modeIndex < collection.modes.length; modeIndex++) {
      modeNameById[collection.modes[modeIndex].modeId] = collection.modes[modeIndex].name;
    }

    const variables = collectionVariables.map(function (variable) {
      const valuesByMode = {};

      for (const modeId in variable.valuesByMode) {
        if (Object.prototype.hasOwnProperty.call(variable.valuesByMode, modeId)) {
          const modeName = modeNameById[modeId] || modeId;
          valuesByMode[modeName] = serializeVariableValue(variable.valuesByMode[modeId]);
        }
      }

      return {
        name: variable.name,
        key: variable.key,
        id: variable.id,
        resolvedType: variable.resolvedType,
        collectionName: collection.name,
        collectionKey: collection.key,
        collectionId: collection.id,
        valuesByMode: valuesByMode
      };
    });

    collectionsLibrary.push({
      name: collection.name,
      key: collection.key,
      id: collection.id,
      defaultModeId: collection.defaultModeId,
      modes: modes,
      variableCount: variables.length,
      variables: variables
    });
  }

  return collectionsLibrary;
}

/**
 * Analyzes the user's focus state on the canvas workspace. Pushes context matrices
 * over to the UI thread dynamically so Step 2 remains a 1-click synchronous event.
 */
function pushCurrentSelection() {
  const selection = figma.currentPage.selection;

  if (selection.length > 0) {
    const nodeData = serializeNodeDeep(selection[0]);
    figma.ui.postMessage({ type: "SELECTION_UPDATED", nodeData: nodeData, hasSelection: true });
  } else {
    figma.ui.postMessage({
      type: "SELECTION_UPDATED",
      nodeData: null,
      hasSelection: false,
      pageName: figma.currentPage.name
    });
  }
}

// Attach automatic focus state canvas triggers
figma.on("selectionchange", pushCurrentSelection);

// Seed data schema immediately on load execution
pushCurrentSelection();

/**
 * Plugin API System Communication Message Traffic Routing Matrix
 */
figma.ui.onmessage = async function (msg) {
  // --- ACTION STEP 1: DEEP DESIGN SYSTEM SPEC COMPILATION ---
  if (msg.type === "GENERATE_DYNAMIC_PRIMING_PROMPT") {
    const allNodes = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });

    // Keep context footprints lightweight by extracting only root components or component-set families
    const rootLibraryNodes = allNodes.filter(function (node) {
      return node.parent.type !== "COMPONENT_SET";
    });

    const dynamicManifest = rootLibraryNodes.map(function (node) {
      return {
        name: node.name,
        key: node.key,
        type: node.type,
        properties: node.type === "COMPONENT_SET" ? Object.keys(node.componentPropertyDefinitions) : undefined
      };
    });

    // Extract systemic variable tokens
    const localVariables = figma.variables ? await figma.variables.getLocalVariablesAsync() : [];

    const variablesLibrary = localVariables.map(function (v) {
      return {
        name: v.name,
        key: v.key,
        id: v.id,
        resolvedType: v.resolvedType,
        variableCollectionId: v.variableCollectionId
      };
    });

    const collectionsLibrary = await buildVariableCollectionsLibrary();

    // Return environment snapshot parameters back to UI thread
    figma.ui.postMessage({
      type: "PRIMING_DATA_READY",
      manifest: dynamicManifest,
      variables: variablesLibrary,
      collections: collectionsLibrary
    });
  }

  // --- ACTION STEP 3: RUN SECURE DESERIALIZED CODE STRINGS ---
  if (msg.type === "RUNUserCode") {
    try {
      // Build safe standalone sandbox wrapper engine around the inbound script text string
      const asyncExecutor = new Function("return (async () => { " + msg.code + " })()");
      await asyncExecutor();
      figma.notify("✅ Layout updates executed cleanly.");
    } catch (error) {
      figma.notify("❌ Engine Script Execution Error: " + error.message, { timeout: 6000 });
    }
  }
};