import type { RLMPreparedContext, RLMResource } from "superobjective";

import type { CompiledRlmStep } from "./rlm-step";

type HostedStepTool = {
  name: string;
  description?: string;
};

type HostedFacetSnapshot = {
  runId: string;
  moduleId: string;
  preparedContext: RLMPreparedContext;
  inlineInputs: Record<string, unknown>;
  textResources: Record<string, string>;
  globals: Record<string, unknown>;
  definitionStatements?: Record<string, string>;
  tools?: HostedStepTool[];
};

function safeClone(value: unknown): unknown {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function sanitizeToolName(name: string): string {
  const sanitized = name
    .replace(/[-.\s]+/g, "_")
    .replace(/[^a-zA-Z0-9_$]/g, "")
    .replace(/^[0-9]/, "_$&");
  return sanitized.length > 0 ? sanitized : "tool";
}

function pathMatchForCorpus(path: string): { corpusId: string; relativePath: string } | null {
  const match = /^\/corpora\/([^/]+)\/(.+)$/.exec(path);
  if (match == null) {
    return null;
  }
  return {
    corpusId: decodeURIComponent(match[1]!),
    relativePath: match[2]!,
  };
}

function readTextSlice(
  text: string,
  options: {
    startChar?: number;
    maxChars?: number;
  },
  fallbackMaxChars: number,
) {
  const startChar = Math.max(0, Math.min(text.length, options.startChar ?? 0));
  const maxChars = Math.max(1, Math.min(options.maxChars ?? fallbackMaxChars, fallbackMaxChars));
  const endChar = Math.min(text.length, startChar + maxChars);

  return {
    startChar,
    endChar,
    totalChars: text.length,
    truncated: endChar < text.length,
    text: text.slice(startChar, endChar),
  };
}

function searchWithinText(
  path: string,
  text: string,
  query: string,
  options: {
    maxResults?: number;
    contextChars?: number;
    caseSensitive?: boolean;
  },
) {
  const haystack = options.caseSensitive ? text : text.toLowerCase();
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const maxResults = Math.max(1, options.maxResults ?? 5);
  const contextChars = Math.max(0, options.contextChars ?? 80);
  const matches: Array<{
    path: string;
    startChar: number;
    endChar: number;
    match: string;
    snippet: string;
  }> = [];

  if (needle.length === 0) {
    return {
      path,
      query,
      matches,
      truncated: false,
    };
  }

  let cursor = 0;
  while (matches.length < maxResults) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) {
      break;
    }
    const startChar = index;
    const endChar = index + needle.length;
    const snippetStart = Math.max(0, startChar - contextChars);
    const snippetEnd = Math.min(text.length, endChar + contextChars);
    matches.push({
      path,
      startChar,
      endChar,
      match: text.slice(startChar, endChar),
      snippet: text.slice(snippetStart, snippetEnd),
    });
    cursor = endChar;
  }

  return {
    path,
    query,
    matches,
    truncated: false,
  };
}

export function buildHostedRlmStepWorkerSource(args: {
  state: HostedFacetSnapshot;
  step: {
    compiled: CompiledRlmStep;
    request: {
      code: string;
      maxOutputChars: number;
      maxQueryCalls: number;
      queryCallsUsed: number;
    };
  };
}): string {
  const { state, step } = args;
  const definitionPrelude = Object.entries(state.definitionStatements ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, statement]) => `if (${name} === undefined) { ${statement} }`)
    .join("\n");
  const trackedPrelude = (step.compiled.trackedNames ?? [])
    .map((name) => `let ${name} = safeClone(SNAPSHOT.globals[${JSON.stringify(name)}]);`)
    .join("\n");
  const trackedSync = (step.compiled.trackedNames ?? [])
    .map((name) => `__syncGlobal(__globals, ${JSON.stringify(name)}, ${name});`)
    .join("\n");
  const toolAliases = (state.tools ?? [])
    .map((tool) => {
      const alias = sanitizeToolName(tool.name);
      return `const ${alias} = async (args = {}) => __callTool(${JSON.stringify(tool.name)}, args, async () => { const response = await __hostFetch("/execute-tool", { runId: SNAPSHOT.runId, moduleId: SNAPSHOT.moduleId, toolName: ${JSON.stringify(tool.name)}, input: args }); return response.output; });`;
    })
    .join("\n");
  const toolObject = (state.tools ?? [])
    .map((tool) => {
      const alias = sanitizeToolName(tool.name);
      return `${JSON.stringify(alias)}: ${alias}`;
    })
    .join(",\n");
  const snapshot = JSON.stringify({
    runId: state.runId,
    moduleId: state.moduleId,
    preparedContext: state.preparedContext,
    inlineInputs: state.inlineInputs,
    textResources: state.textResources,
    globals: state.globals ?? {},
    request: step.request,
  });

  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    `const SNAPSHOT = ${snapshot};`,
    readTextSlice.toString(),
    searchWithinText.toString(),
    pathMatchForCorpus.toString(),
    safeClone.toString(),
    "function cloneValue(value) { return safeClone(value); }",
    "function nowIso() { return new Date().toISOString(); }",
    "function isRecord(value) { return typeof value === \"object\" && value !== null; }",
    "function __formatValue(value) { if (typeof value === \"string\") return value; try { return JSON.stringify(value); } catch { return String(value); } }",
    "function __syncGlobal(target, key, value) { const cloned = safeClone(value); if (cloned === undefined && value !== undefined) { delete target[key]; return; } target[key] = cloned; }",
    "export class RlmStepRunner extends WorkerEntrypoint {",
    "  async run() {",
    "    const __globals = cloneValue(SNAPSHOT.globals ?? {});",
    "    let __submitted;",
    "    let __queryCallsUsed = SNAPSHOT.request.queryCallsUsed;",
    "    const __logs = [];",
    "    const __toolCalls = [];",
    "    const inputs = SNAPSHOT.inlineInputs ?? {};",
    "    const SUBMIT = async (value) => { __submitted = value; return value; };",
    "    const print = (...args) => { __logs.push(args.map(__formatValue).join(\" \")); };",
    "    const console = { log: (...args) => print(...args), warn: (...args) => print(...args), error: (...args) => print(...args) };",
    "    const getInput = async (key) => key == null ? inputs : inputs[key];",
    "    const getManifest = async () => SNAPSHOT.preparedContext?.manifest ?? null;",
    "    const listResources = async () => SNAPSHOT.preparedContext?.resources ?? [];",
    "    const __hostFetch = async (path, payload) => { const response = await fetch(`https://runtime.local${path}`, { method: \"POST\", headers: { \"content-type\": \"application/json\" }, body: JSON.stringify(payload) }); if (!response.ok) { throw new Error(await response.text()); } return response.json(); };",
    "    const __readTextResource = async (path) => { const prepared = SNAPSHOT.preparedContext ?? {}; if (path === prepared.manifestPath) { const text = SNAPSHOT.textResources[path] ?? JSON.stringify(prepared.manifest ?? {}); return { path, storage: \"prepared\", text, totalChars: text.length, preview: text.slice(0, 240) }; } if (Object.prototype.hasOwnProperty.call(SNAPSHOT.textResources, path)) { const text = SNAPSHOT.textResources[path]; return { path, storage: \"prepared\", text, totalChars: text.length, preview: text.slice(0, 240) }; } const corpusMatch = pathMatchForCorpus(path); if (corpusMatch != null) { const response = await __hostFetch(\"/read-corpus-file\", { runId: SNAPSHOT.runId, moduleId: SNAPSHOT.moduleId, corpusId: corpusMatch.corpusId, path: corpusMatch.relativePath }); const text = response.content; return { path, storage: \"corpus\", text, totalChars: text.length, preview: text.slice(0, 240) }; } throw new Error(`Unknown prepared text path: ${path}`); };",
    "    const __callTool = async (toolName, input, fn) => { const startedAt = nowIso(); try { const output = await fn(); __toolCalls.push({ toolName, input, output, source: \"rlm\", startedAt, endedAt: nowIso() }); return output; } catch (error) { const serialized = { message: error instanceof Error ? error.message : String(error) }; __toolCalls.push({ toolName, input, error: serialized, source: \"rlm\", startedAt, endedAt: nowIso() }); throw error; } };",
    "    const query = async (prompt, options) => __callTool(\"rlm.query\", { prompt, options }, async () => { __queryCallsUsed += 1; if (__queryCallsUsed > SNAPSHOT.request.maxQueryCalls) throw new Error(`RLM query budget exceeded: ${__queryCallsUsed} > ${SNAPSHOT.request.maxQueryCalls}.`); const response = await __hostFetch(\"/query\", { runId: SNAPSHOT.runId, moduleId: SNAPSHOT.moduleId, prompt, options }); return response.text; });",
    "    const llm_query = async (prompt, options) => query(prompt, options);",
    "    const queryBatch = async (prompts, options) => __callTool(\"rlm.queryBatch\", { prompts, options }, async () => { __queryCallsUsed += prompts.length; if (__queryCallsUsed > SNAPSHOT.request.maxQueryCalls) throw new Error(`RLM query budget exceeded: ${__queryCallsUsed} > ${SNAPSHOT.request.maxQueryCalls}.`); const response = await __hostFetch(\"/query-batch\", { runId: SNAPSHOT.runId, moduleId: SNAPSHOT.moduleId, prompts, options }); return response.texts; });",
    "    const llm_query_batched = async (prompts, options) => queryBatch(prompts, options);",
    "    const getTextInfo = async (path) => __callTool(\"rlm.getTextInfo\", { path }, async () => { const resource = await __readTextResource(path); return { path: resource.path, storage: resource.storage, totalChars: resource.totalChars, preview: resource.preview }; });",
    "    const readText = async (path, options = {}) => __callTool(\"rlm.readText\", { path, ...options }, async () => { const resource = await __readTextResource(path); const startChar = Math.max(0, Math.min(resource.text.length, options.startChar ?? 0)); const maxChars = Math.max(1, Math.min(options.maxChars ?? SNAPSHOT.request.maxOutputChars, SNAPSHOT.request.maxOutputChars)); const endChar = Math.min(resource.text.length, startChar + maxChars); return { path: resource.path, storage: resource.storage, startChar, endChar, totalChars: resource.text.length, truncated: endChar < resource.text.length, text: resource.text.slice(startChar, endChar) }; });",
    "    const searchText = async (path, queryText, options = {}) => __callTool(\"rlm.searchText\", { path, query: queryText, ...options }, async () => { const resource = await __readTextResource(path); const haystack = options.caseSensitive ? resource.text : resource.text.toLowerCase(); const needle = options.caseSensitive ? queryText : queryText.toLowerCase(); const maxResults = Math.max(1, options.maxResults ?? 5); const contextChars = Math.max(0, options.contextChars ?? 80); const matches = []; if (needle.length > 0) { let cursor = 0; while (matches.length < maxResults) { const index = haystack.indexOf(needle, cursor); if (index < 0) break; const startChar = index; const endChar = index + needle.length; const snippetStart = Math.max(0, startChar - contextChars); const snippetEnd = Math.min(resource.text.length, endChar + contextChars); matches.push({ path: resource.path, startChar, endChar, match: resource.text.slice(startChar, endChar), snippet: resource.text.slice(snippetStart, snippetEnd) }); cursor = endChar; } } return { path: resource.path, storage: resource.storage, query: queryText, matches, truncated: false }; });",
    "    const readMatchWindow = async (path, match, options = {}) => __callTool(\"rlm.readMatchWindow\", { path, match, ...options }, async () => { const resource = await __readTextResource(path); const beforeChars = Math.max(0, options.beforeChars ?? 80); const afterChars = Math.max(0, options.afterChars ?? 80); const startChar = Math.max(0, match.startChar - beforeChars); const defaultMaxChars = match.endChar - match.startChar + beforeChars + afterChars; const maxChars = Math.max(1, Math.min(options.maxChars ?? defaultMaxChars, SNAPSHOT.request.maxOutputChars)); const endChar = Math.min(resource.text.length, startChar + maxChars); return { path: resource.path, storage: resource.storage, startChar, endChar, totalChars: resource.text.length, truncated: endChar < resource.text.length, text: resource.text.slice(startChar, endChar) }; });",
    "    const listCorpusFiles = async (corpusId, prefix) => __callTool(\"rlm.listCorpusFiles\", prefix == null ? { corpusId } : { corpusId, prefix }, async () => { const response = await __hostFetch(\"/list-corpus-files\", prefix == null ? { runId: SNAPSHOT.runId, moduleId: SNAPSHOT.moduleId, corpusId } : { runId: SNAPSHOT.runId, moduleId: SNAPSHOT.moduleId, corpusId, prefix }); return response.files; });",
    "    const readCorpusFile = async (corpusId, path) => __callTool(\"rlm.readCorpusFile\", { corpusId, path }, async () => __hostFetch(\"/read-corpus-file\", { runId: SNAPSHOT.runId, moduleId: SNAPSHOT.moduleId, corpusId, path }));",
    "    const searchCorpus = async (corpusId, args = {}) => __callTool(\"rlm.searchCorpus\", { corpusId, ...(args ?? {}) }, async () => __hostFetch(\"/search-corpus\", { runId: SNAPSHOT.runId, moduleId: SNAPSHOT.moduleId, corpusId, ...(args ?? {}) }));",
    trackedPrelude,
    definitionPrelude.length > 0 ? `    ${definitionPrelude}` : "",
    toolAliases,
    "    const tools = {",
    toolObject.length > 0 ? `    ${toolObject}` : "",
    "    };",
    step.compiled.transformedCode,
    trackedSync,
    "    return { submitted: __submitted, queryCallsUsed: __queryCallsUsed, logs: __logs, stdout: __logs.length > 0 ? __logs.join(\"\\n\") : undefined, toolCalls: __toolCalls, globals: __globals };",
    "  }",
    "}",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
