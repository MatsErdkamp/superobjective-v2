import type { ArtifactStore, CompiledArtifact, RunTrace, TraceStore } from "./types";

type MemoryStore = ArtifactStore & TraceStore;
type NodeFsPromises = typeof import("node:fs/promises");
type NodePathModule = typeof import("node:path");
type ProcessWithBuiltins = {
  getBuiltinModule?: <TModule>(id: string) => TModule;
};

export function memoryStore(): MemoryStore {
  const artifacts = new Map<string, CompiledArtifact>();
  const activeArtifacts = new Map<string, string>();
  const traces = new Map<string, RunTrace>();

  return {
    async saveArtifact(artifact) {
      artifacts.set(artifact.id, artifact);
    },
    async loadArtifact(id) {
      return artifacts.get(id) ?? null;
    },
    async listArtifacts(args) {
      const values = [...artifacts.values()]
        .filter((artifact) => {
          if (args?.targetKind && artifact.target.kind !== args.targetKind) {
            return false;
          }

          if (args?.targetId && artifact.target.id !== args.targetId) {
            return false;
          }

          return true;
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

      return args?.limit ? values.slice(0, args.limit) : values;
    },
    async loadActiveArtifact(args) {
      const key = `${args.targetKind}:${args.targetId}`;
      const artifactId = activeArtifacts.get(key);
      if (!artifactId) {
        return null;
      }

      return artifacts.get(artifactId) ?? null;
    },
    async setActiveArtifact(args) {
      activeArtifacts.set(`${args.targetKind}:${args.targetId}`, args.artifactId);
    },
    async saveTrace(trace) {
      traces.set(trace.runId, trace);
    },
    async loadTrace(runId) {
      return traces.get(runId) ?? null;
    },
    async listTraces(args) {
      const values = [...traces.values()];
      return values.filter((trace) => {
        if (args?.targetId && trace.targetId !== args.targetId) {
          return false;
        }

        if (args?.targetKind && trace.targetKind !== args.targetKind) {
          return false;
        }

        return true;
      });
    },
  };
}

async function ensureDir(path: string) {
  const fs = await importNodeFsPromises();
  await fs.mkdir(path, {
    recursive: true,
  });
}

async function readJsonFile<TValue>(path: string): Promise<TValue | null> {
  try {
    const fs = await importNodeFsPromises();
    const content = await fs.readFile(path, "utf8");
    return JSON.parse(content) as TValue;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

export function filesystemStore(rootDir: string): MemoryStore {
  return {
    async saveArtifact(artifact) {
      const pathModule = await importNodePath();
      const fs = await importNodeFsPromises();
      const artifactsDir = pathModule.join(rootDir, "artifacts");
      await ensureDir(artifactsDir);
      await fs.writeFile(
        pathModule.join(artifactsDir, `${artifact.id}.json`),
        JSON.stringify(artifact, null, 2),
        "utf8",
      );
    },
    async loadArtifact(id) {
      const pathModule = await importNodePath();
      const artifactsDir = pathModule.join(rootDir, "artifacts");
      return readJsonFile<CompiledArtifact>(pathModule.join(artifactsDir, `${id}.json`));
    },
    async listArtifacts(args) {
      try {
        const pathModule = await importNodePath();
        const fs = await importNodeFsPromises();
        const artifactsDir = pathModule.join(rootDir, "artifacts");
        const filenames = await fs.readdir(artifactsDir);
        const artifacts = await Promise.all(
          filenames
            .filter((filename: string) => filename.endsWith(".json"))
            .map((filename: string) =>
              readJsonFile<CompiledArtifact>(pathModule.join(artifactsDir, filename)),
            ),
        );

        const filtered = artifacts
          .filter((artifact): artifact is CompiledArtifact => Boolean(artifact))
          .filter((artifact) => {
            if (args?.targetKind && artifact.target.kind !== args.targetKind) {
              return false;
            }

            if (args?.targetId && artifact.target.id !== args.targetId) {
              return false;
            }

            return true;
          })
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

        return args?.limit ? filtered.slice(0, args.limit) : filtered;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          return [];
        }

        throw error;
      }
    },
    async loadActiveArtifact(args) {
      const pathModule = await importNodePath();
      const artifactsDir = pathModule.join(rootDir, "artifacts");
      const activePath = pathModule.join(rootDir, "active-artifacts.json");
      const active = (await readJsonFile<Record<string, string>>(activePath)) ?? {};
      const artifactId = active[`${args.targetKind}:${args.targetId}`];
      if (!artifactId) {
        return null;
      }

      return readJsonFile<CompiledArtifact>(pathModule.join(artifactsDir, `${artifactId}.json`));
    },
    async setActiveArtifact(args) {
      const pathModule = await importNodePath();
      const fs = await importNodeFsPromises();
      const activePath = pathModule.join(rootDir, "active-artifacts.json");
      const active = (await readJsonFile<Record<string, string>>(activePath)) ?? {};
      active[`${args.targetKind}:${args.targetId}`] = args.artifactId;
      await ensureDir(rootDir);
      await fs.writeFile(activePath, JSON.stringify(active, null, 2), "utf8");
    },
    async saveTrace(trace) {
      const pathModule = await importNodePath();
      const fs = await importNodeFsPromises();
      const tracesDir = pathModule.join(rootDir, "traces");
      await ensureDir(tracesDir);
      await fs.writeFile(
        pathModule.join(tracesDir, `${trace.runId}.json`),
        JSON.stringify(trace, null, 2),
        "utf8",
      );
    },
    async loadTrace(runId) {
      const pathModule = await importNodePath();
      const tracesDir = pathModule.join(rootDir, "traces");
      return readJsonFile<RunTrace>(pathModule.join(tracesDir, `${runId}.json`));
    },
    async listTraces(args) {
      try {
        const pathModule = await importNodePath();
        const fs = await importNodeFsPromises();
        const tracesDir = pathModule.join(rootDir, "traces");
        const filenames = await fs.readdir(tracesDir);
        const traces = await Promise.all(
          filenames
            .filter((filename: string) => filename.endsWith(".json"))
            .map((filename: string) =>
              readJsonFile<RunTrace>(pathModule.join(tracesDir, filename)),
            ),
        );

        return traces
          .filter((trace): trace is RunTrace => Boolean(trace))
          .filter((trace) => {
            if (args?.targetId && trace.targetId !== args.targetId) {
              return false;
            }

            if (args?.targetKind && trace.targetKind !== args.targetKind) {
              return false;
            }

            return true;
          });
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          return [];
        }

        throw error;
      }
    },
  };
}

function hasErrorCode(error: unknown, code: string): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function importNodeFsPromises(): Promise<NodeFsPromises> {
  return Promise.resolve(getNodeBuiltin<NodeFsPromises>("node:fs/promises"));
}

function importNodePath(): Promise<NodePathModule> {
  return Promise.resolve(getNodeBuiltin<NodePathModule>("node:path"));
}

function getNodeBuiltin<TModule>(moduleId: string): TModule {
  const processValue = (globalThis as { process?: ProcessWithBuiltins }).process;
  const getBuiltinModule = processValue?.getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    throw new Error(
      "filesystemStore() requires a Node.js runtime with process.getBuiltinModule() support.",
    );
  }

  return getBuiltinModule<TModule>(moduleId);
}

export const memory = memoryStore;
export const filesystem = filesystemStore;

export const stores = {
  memory,
  filesystem,
};
