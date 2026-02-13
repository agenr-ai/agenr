import { parse as parseYaml } from "yaml";

const OPENAPI_PATHS = [
  "/openapi.json",
  "/api/openapi.json",
  "/api/v1/openapi.json",
  "/swagger.json",
  "/api-docs",
  "/swagger/v1/swagger.json",
  "/.well-known/openapi.json",
  "/docs/openapi.json",
] as const;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown> | null, key: string): string {
  if (!record) return "";
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeDomain(domain: string): string {
  const input = domain.trim();
  if (!input) {
    throw new Error("Domain cannot be empty.");
  }

  try {
    const parsed = new URL(input.includes("://") ? input : `https://${input}`);
    return parsed.host;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid domain '${domain}': ${message}`);
  }
}

function describeSchema(schema: unknown, depth = 0): string {
  if (depth > 2) return "...";

  const record = asRecord(schema);
  if (!record) return "unknown";

  const ref = readString(record, "$ref");
  if (ref) return `ref(${ref})`;

  const type = record.type;
  if (typeof type === "string") {
    if (type === "array") {
      return `array<${describeSchema(record.items, depth + 1)}>`;
    }

    if (type === "object") {
      const properties = asRecord(record.properties);
      const keys = properties ? Object.keys(properties).slice(0, 6) : [];
      return keys.length > 0 ? `object{${keys.join(",")}${keys.length === 6 ? ",..." : ""}}` : "object";
    }

    return type;
  }

  const oneOf = asArray(record.oneOf);
  if (oneOf.length > 0) {
    return `oneOf(${oneOf.slice(0, 3).map((entry) => describeSchema(entry, depth + 1)).join("|")})`;
  }

  const anyOf = asArray(record.anyOf);
  if (anyOf.length > 0) {
    return `anyOf(${anyOf.slice(0, 3).map((entry) => describeSchema(entry, depth + 1)).join("|")})`;
  }

  const allOf = asArray(record.allOf);
  if (allOf.length > 0) {
    return `allOf(${allOf.slice(0, 3).map((entry) => describeSchema(entry, depth + 1)).join("+")})`;
  }

  return "unknown";
}

function parseSpecDocument(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("OpenAPI document was empty.");
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      throw new Error("Parsed JSON OpenAPI document was not an object.");
    }
    return record;
  } catch {
    // Fall through to YAML parsing.
  }

  const parsedYaml = parseYaml(trimmed);
  const record = asRecord(parsedYaml);
  if (!record) {
    throw new Error("Parsed YAML OpenAPI document was not an object.");
  }
  return record;
}

function extractBaseUrls(spec: Record<string, unknown>): string[] {
  const baseUrls: string[] = [];

  for (const server of asArray(spec.servers)) {
    const serverRecord = asRecord(server);
    const url = readString(serverRecord, "url");
    if (url) baseUrls.push(url);
  }

  const host = readString(spec, "host");
  if (host) {
    const basePath = readString(spec, "basePath");
    const schemes = asArray(spec.schemes)
      .map((scheme) => (typeof scheme === "string" ? scheme.trim() : ""))
      .filter(Boolean);
    const normalizedSchemes = schemes.length > 0 ? schemes : ["https"];

    for (const scheme of normalizedSchemes) {
      baseUrls.push(`${scheme}://${host}${basePath || ""}`);
    }
  }

  return dedupe(baseUrls);
}

function extractAuthSchemes(spec: Record<string, unknown>): string[] {
  const auth: string[] = [];

  const components = asRecord(spec.components);
  const securitySchemes = asRecord(components?.securitySchemes);
  if (securitySchemes) {
    for (const [name, value] of Object.entries(securitySchemes)) {
      const scheme = asRecord(value);
      const type = readString(scheme, "type") || "unknown";
      const schemeName = readString(scheme, "scheme");
      const flows = asRecord(scheme?.flows);
      const flowNames = flows ? Object.keys(flows) : [];
      auth.push(
        [
          `${name}: ${type}`,
          schemeName ? `scheme=${schemeName}` : "",
          flowNames.length > 0 ? `flows=${flowNames.join(",")}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
  }

  const securityDefinitions = asRecord(spec.securityDefinitions);
  if (securityDefinitions) {
    for (const [name, value] of Object.entries(securityDefinitions)) {
      const scheme = asRecord(value);
      const type = readString(scheme, "type") || "unknown";
      const inLocation = readString(scheme, "in");
      const headerName = readString(scheme, "name");
      auth.push(
        [
          `${name}: ${type}`,
          inLocation ? `in=${inLocation}` : "",
          headerName ? `name=${headerName}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
  }

  for (const security of asArray(spec.security)) {
    const securityRecord = asRecord(security);
    if (!securityRecord) continue;
    for (const [name, value] of Object.entries(securityRecord)) {
      const scopes = asArray(value)
        .map((scope) => (typeof scope === "string" ? scope : ""))
        .filter(Boolean);
      auth.push(scopes.length > 0 ? `requirement: ${name} scopes=${scopes.join(",")}` : `requirement: ${name}`);
    }
  }

  return dedupe(auth);
}

function extractSchemaNames(spec: Record<string, unknown>): string[] {
  const schemaNames: string[] = [];

  const components = asRecord(spec.components);
  const componentSchemas = asRecord(components?.schemas);
  if (componentSchemas) {
    schemaNames.push(...Object.keys(componentSchemas));
  }

  const definitions = asRecord(spec.definitions);
  if (definitions) {
    schemaNames.push(...Object.keys(definitions));
  }

  return dedupe(schemaNames);
}

function extractOperationShapes(
  method: string,
  endpointPath: string,
  operation: Record<string, unknown>,
  requestShapes: string[],
  responseShapes: string[],
): void {
  const requestBody = asRecord(operation.requestBody);
  if (requestBody) {
    const requestRef = readString(requestBody, "$ref");
    if (requestRef) {
      requestShapes.push(`${method} ${endpointPath} request: ${requestRef}`);
    }

    const content = asRecord(requestBody.content);
    if (content) {
      for (const [mediaType, contentType] of Object.entries(content)) {
        const contentRecord = asRecord(contentType);
        const schemaDescription = describeSchema(contentRecord?.schema);
        requestShapes.push(`${method} ${endpointPath} request(${mediaType}): ${schemaDescription}`);
      }
    }
  }

  for (const parameter of asArray(operation.parameters)) {
    const parameterRecord = asRecord(parameter);
    if (!parameterRecord) continue;

    const inValue = readString(parameterRecord, "in");
    if (inValue !== "body") continue;

    const name = readString(parameterRecord, "name") || "body";
    const schemaDescription = describeSchema(parameterRecord.schema);
    requestShapes.push(`${method} ${endpointPath} request(${name}): ${schemaDescription}`);
  }

  const responses = asRecord(operation.responses);
  if (responses) {
    for (const [statusCode, response] of Object.entries(responses)) {
      const responseRecord = asRecord(response);
      const description = readString(responseRecord, "description");
      const schemaDescription = describeSchema(responseRecord?.schema);

      const openApiContent = asRecord(responseRecord?.content);
      if (openApiContent) {
        for (const [mediaType, mediaValue] of Object.entries(openApiContent)) {
          const mediaRecord = asRecord(mediaValue);
          const mediaSchema = describeSchema(mediaRecord?.schema);
          responseShapes.push(`${method} ${endpointPath} response(${statusCode},${mediaType}): ${mediaSchema}`);
        }
      }

      responseShapes.push(
        `${method} ${endpointPath} response(${statusCode}): ${description || schemaDescription || "unspecified"}`,
      );
    }
  }
}

export async function probeOpenApiPaths(domain: string): Promise<string[]> {
  const normalizedDomain = normalizeDomain(domain);
  const found: string[] = [];

  for (const openApiPath of OPENAPI_PATHS) {
    const candidate = `https://${normalizedDomain}${openApiPath}`;

    try {
      const response = await fetch(candidate, {
        method: "HEAD",
        redirect: "follow",
      });

      if (response.ok) {
        found.push(candidate);
      }
    } catch {
      // Ignore per-path failures.
    }
  }

  return dedupe(found);
}

export async function fetchAndParseOpenApiSpec(url: string): Promise<object> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      Accept: "application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI spec from '${url}': ${response.status} ${response.statusText}`);
  }

  const raw = await response.text();
  const spec = parseSpecDocument(raw);
  const info = asRecord(spec.info);

  const endpoints: Array<{ method: string; path: string; description: string }> = [];
  const requestShapes: string[] = [];
  const responseShapes: string[] = [];

  const paths = asRecord(spec.paths);
  if (paths) {
    for (const [endpointPath, pathDefinition] of Object.entries(paths)) {
      const pathRecord = asRecord(pathDefinition);
      if (!pathRecord) continue;

      for (const method of HTTP_METHODS) {
        const operation = asRecord(pathRecord[method]);
        if (!operation) continue;

        const description = readString(operation, "summary") || readString(operation, "description");
        endpoints.push({
          method: method.toUpperCase(),
          path: endpointPath,
          description,
        });

        extractOperationShapes(method.toUpperCase(), endpointPath, operation, requestShapes, responseShapes);
      }
    }
  }

  return {
    sourceUrl: url,
    openapi: readString(spec, "openapi") || readString(spec, "swagger") || "unknown",
    title: readString(info, "title"),
    version: readString(info, "version"),
    baseUrls: extractBaseUrls(spec),
    authSchemes: extractAuthSchemes(spec),
    endpoints,
    schemaNames: extractSchemaNames(spec),
    requestShapes: dedupe(requestShapes),
    responseShapes: dedupe(responseShapes),
  };
}
