import { z } from "zod";

import { cloudflare } from "@superobjective/cloudflare";
import { so, type ModelProvider } from "superobjective";

const shellProbeModel: ModelProvider = {
  id: "scripted-shell-workspace-probe",
  async structured(args) {
    const messagesText = JSON.stringify(args.messages ?? []);
    const step = messagesText.includes("workspace_info_after_write") ? 2 : 1;
    return {
      object:
        step === 1
          ? {
              reasoning: "Create durable workspace files and force a large-file R2 spillover if R2 is bound.",
              code: [
                "await state.mkdir('/work', { recursive: true });",
                "await state.writeText('/work/probe.txt', inputs.message);",
                "await state.writeJson('/work/probe.json', { message: inputs.message, upper: inputs.message.toUpperCase() });",
                "await state.writeText('/work/large.txt', 'x'.repeat(1600000));",
                "const workspace_info_after_write = await state.info();",
                "print('workspace_info_after_write', JSON.stringify(workspace_info_after_write));",
              ].join("\n"),
            }
          : {
              reasoning: "Read the durable workspace files, verify search, clean the large file, and submit.",
              code: [
                "const text = await state.readText('/work/probe.txt');",
                "const data = await state.readJson('/work/probe.json');",
                "const files = await state.glob('/work/*');",
                "const matches = await state.searchFiles('/work/*.txt', text, { maxResults: 1 });",
                "const beforeCleanup = await state.info();",
                "await state.rm('/work/large.txt', { force: true });",
                "const afterCleanup = await state.info();",
                "await SUBMIT({ answer: data.upper, evidence: text, file_count: files.length, match_count: matches.length, r2_file_count_before_cleanup: beforeCleanup.r2FileCount, r2_file_count_after_cleanup: afterCleanup.r2FileCount });",
              ].join("\n"),
            },
    };
  },
};

export const inspectShellWorkspace = so.rlm(
  so
    .signature("inspect_shell_workspace")
    .withInstructions("Exercise the Cloudflare shell-backed durable state workspace.")
    .withInput("message", z.string(), {
      description: "Probe message to persist in the durable state workspace.",
    })
    .withOutput("answer", z.string(), {
      description: "Uppercase probe message read back from durable JSON state.",
    })
    .withOutput("evidence", z.string(), {
      description: "Exact probe text read back from durable text state.",
    })
    .withOutput("file_count", z.number(), {
      description: "Number of files observed by state.glob before cleanup.",
    })
    .withOutput("match_count", z.number(), {
      description: "Number of files with a text search hit.",
    })
    .withOutput("r2_file_count_before_cleanup", z.number(), {
      description: "Workspace R2-backed file count before deleting the large probe file.",
    })
    .withOutput("r2_file_count_after_cleanup", z.number(), {
      description: "Workspace R2-backed file count after deleting the large probe file.",
    })
    .build(),
  {
    runtime: cloudflare.rlm.runtime(),
    model: shellProbeModel,
    maxIterations: 2,
    maxLlmCalls: 2,
    extract: {
      enabled: false,
    },
  },
);
