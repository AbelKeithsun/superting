"use strict";

/**
 * CLI bridge projection of the operation registry.
 *
 * Produces the route table that `src/helpers/cliBridge.js` serves. Keeping the
 * projection declarative means the HTTP layer no longer knows anything about
 * notes, dictionaries or actions: it authenticates, matches a route, collects
 * path/query/body parameters, and hands them to the registry.
 */

function matchPath(template, pathname) {
  if (!template.includes(":")) return pathname === template ? {} : null;
  const templateParts = template.split("/");
  const pathParts = pathname.split("/");
  if (templateParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < templateParts.length; i += 1) {
    const templatePart = templateParts[i];
    const pathPart = pathParts[i];
    if (templatePart.startsWith(":")) {
      if (!pathPart) return null;
      params[templatePart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (templatePart !== pathPart) return null;
  }
  return params;
}

function collectParams(operation, { params = {}, query, body } = {}) {
  const cli = operation.cli;
  const out = {};

  for (const [name, spec] of Object.entries(operation.params)) {
    const location = cli.params?.[name];
    if (location === "path") {
      if (params[name] !== undefined) out[name] = params[name];
      continue;
    }
    if (location === "query") {
      const key = cli.queryKeys?.[name] ?? name;
      const values = query?.getAll?.(key) ?? [];
      if (values.length > 1) out[name] = spec.type === "array" ? values : values[values.length - 1];
      else if (values.length === 1) out[name] = values[0];
    } else if (location === "body") {
      if (body && name in body) out[name] = body[name];
    } else if (body && name in body) {
      // Unmapped params are still accepted from the body for newer operations.
      out[name] = body[name];
    }
    // Accepted wire aliases (e.g. `q` for `query`).
    if (out[name] === undefined) {
      for (const [wireKey, target] of Object.entries(cli.aliases ?? {})) {
        if (target !== name) continue;
        const values = query?.getAll?.(wireKey) ?? [];
        if (values.length > 0) out[name] = values.length > 1 ? values : values[0];
      }
    }
  }

  return out;
}

/**
 * @param {import("./registry").AppRegistry} registry
 * @param {object} context Handler context (db / ipc / broadcast / renderer)
 * @returns {Array<{method: string, match: Function, handler: Function, status?: number, noContent?: boolean}>}
 */
function buildCliRoutes(registry, context) {
  return registry
    .list()
    .filter((operation) => operation.cli)
    .map((operation) => {
      const cli = operation.cli;
      return {
        operationId: operation.id,
        method: cli.method,
        match: (pathname) => matchPath(cli.path, pathname),
        status: cli.status,
        noContent: !!cli.noContent,
        handler: async (request) => {
          const raw = collectParams(operation, request);
          const payload = await registry.invoke(operation.id, raw, context ?? {});
          if (cli.noContent) return payload;
          if (typeof cli.serialize === "function") return cli.serialize(payload, raw);
          return payload;
        },
      };
    });
}

module.exports = { buildCliRoutes, collectParams, matchPath };
