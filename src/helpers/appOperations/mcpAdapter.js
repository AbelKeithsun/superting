"use strict";

/**
 * MCP projection of the operation registry.
 *
 * Every registry operation with an `mcp` projection becomes an MCP tool whose
 * input schema is derived from the operation's declarative params, and whose
 * annotations are derived from its policy — so a new capability can never be
 * available to the CLI but missing from MCP (or vice versa) without the parity
 * test failing.
 */

function buildZodShape(operation, z) {
  const shape = {};
  for (const [name, spec] of Object.entries(operation.params)) {
    let field;
    switch (spec.type) {
      case "number":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field =
          spec.items === "object"
            ? z.array(z.object({}).passthrough())
            : spec.items === "number"
              ? z.array(z.number())
              : z.array(z.string());
        break;
      case "object":
        field = z.object({}).passthrough();
        break;
      default:
        field = spec.enum ? z.enum(spec.enum) : z.string();
    }
    if (spec.description) field = field.describe(spec.description);
    if (!spec.required) field = field.optional();
    shape[name] = field;
  }
  return shape;
}

function annotationsFor(operation) {
  return {
    readOnlyHint: operation.policy === "read",
    destructiveHint: operation.policy === "destructive",
  };
}

/**
 * @param {object} server MCP server instance
 * @param {import("./registry").AppRegistry} registry
 * @param {{ z: object, sendMcpToolResult: Function, context: object }} deps
 */
function registerRegistryTools(server, registry, { z, sendMcpToolResult, context }) {
  const registered = [];
  for (const operation of registry.list()) {
    if (!operation.mcp) continue;
    server.registerTool(
      operation.mcp.name,
      {
        title: operation.title,
        description: operation.description,
        inputSchema: buildZodShape(operation, z),
        annotations: annotationsFor(operation),
      },
      async (args) => {
        try {
          const payload = await registry.invoke(operation.id, args, context);
          const serialized =
            typeof operation.mcp.serialize === "function"
              ? operation.mcp.serialize(payload, args)
              : { success: true, data: payload.data };
          return sendMcpToolResult(serialized);
        } catch (error) {
          return sendMcpToolResult({
            success: false,
            error: error?.message || "Operation failed",
            data: null,
          });
        }
      }
    );
    registered.push(operation.mcp.name);
  }
  return registered;
}

module.exports = { annotationsFor, buildZodShape, registerRegistryTools };
