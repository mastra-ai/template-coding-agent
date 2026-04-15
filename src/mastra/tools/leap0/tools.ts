import { createTool } from '@mastra/core/tools';
import z from 'zod';
import {
  CodeLanguage,
  DEFAULT_CODE_INTERPRETER_TEMPLATE_NAME,
  Leap0NotFoundError,
} from 'leap0';
import {
  getLeap0Client,
  getSandboxAndNormalizedListPath,
  getSandboxWithWorkdir,
  normalizeSandboxPath,
} from './utils';

/** Leap0 sandbox idle timeout: seconds, SDK allows 1–28800. */
const SANDBOX_IDLE_TIMEOUT_SEC_MIN = 1;
const SANDBOX_IDLE_TIMEOUT_SEC_MAX = 28_800;

function sandboxIdleTimeoutSecondsFromMs(ms: number): number {
  const seconds = Math.ceil(ms / 1000);
  return Math.min(SANDBOX_IDLE_TIMEOUT_SEC_MAX, Math.max(SANDBOX_IDLE_TIMEOUT_SEC_MIN, seconds));
}

function timeoutMsToSeconds(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function serializeCodeResult(payload: unknown): string {
  return JSON.stringify(payload);
}

function toError(e: unknown): { error: string } {
  if (e instanceof Error) {
    return { error: e.message };
  }
  try {
    return { error: typeof e === 'string' ? e : JSON.stringify(e) ?? String(e) };
  } catch {
    return { error: String(e) };
  }
}

function formatBytes(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) {
    return '0 B';
  }
  const rawIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const i = Math.min(rawIndex, sizes.length - 1);
  const size = (bytes / Math.pow(1024, i)).toFixed(1);
  return `${size} ${sizes[i]}`;
}

export const createSandbox = createTool({
  id: 'createSandbox',
  description: 'Create a sandbox',
  inputSchema: z.object({
    metadata: z.record(z.string()).optional().describe('Custom metadata (ignored for Leap0; reserved for cross-provider parity)'),
    envs: z.record(z.string()).optional().describe(`
      Custom environment variables for the sandbox.
      Used when executing commands and code in the sandbox.
    `),
    timeoutMS: z.number().optional().describe(`
      Timeout for the sandbox in **milliseconds** (converted to seconds for Leap0; clamped to 1–28800s per SDK).
      @default 300_000 // 5 minutes (300s)
    `),
    memoryMiB: z
      .number()
      .int()
      .min(512)
      .max(8192)
      .refine((n) => n % 2 === 0, { message: 'memoryMiB must be even (Leap0 requirement)' })
      .optional()
      .describe('Sandbox memory in **MiB** (Leap0: even integer 512–8192). Omit for SDK default (1024).'),
    vcpu: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe('Sandbox vCPUs (Leap0: 1–8). Omit for SDK default (1).'),
  }),
  outputSchema: z
    .object({
      sandboxId: z.string(),
    })
    .or(
      z.object({
        error: z.string(),
      }),
    ),
  execute: async ({ envs, timeoutMS, memoryMiB, vcpu }) => {
    try {
      const client = getLeap0Client();
      const timeout = sandboxIdleTimeoutSecondsFromMs(timeoutMS ?? 300_000);
      const sandbox = await client.sandboxes.create({
        templateName: DEFAULT_CODE_INTERPRETER_TEMPLATE_NAME,
        envVars: envs,
        timeout,
        ...(memoryMiB !== undefined ? { memory: memoryMiB } : {}),
        ...(vcpu !== undefined ? { vcpu } : {}),
      });
      return { sandboxId: sandbox.id };
    } catch (e) {
      return toError(e);
    }
  },
});

export const runCode = createTool({
  id: 'runCode',
  description: 'Run code in a sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to run the code'),
    code: z.string().describe('The code to run in the sandbox'),
    runCodeOpts: z
      .object({
        language: z
          .enum(['ts', 'js', 'python'])
          .default('python')
          .describe('Language used for code execution. Leap0 code interpreter supports python and typescript; javascript runs via Node.'),
        envs: z.record(z.string()).optional().describe('Custom environment variables for code execution.'),
        timeoutMS: z.number().optional().describe('Timeout for the code execution in **milliseconds**.'),
        requestTimeoutMs: z.number().optional().describe('Unused for Leap0.'),
        contextId: z
          .string()
          .optional()
          .describe(
            'Existing Leap0 code interpreter context id (python/typescript only). When set, execution reuses that context and it is not deleted when the tool returns. When omitted, a one-shot context is removed after execution.',
          ),
      })
      .optional()
      .describe('Run code options'),
  }),
  outputSchema: z
    .object({
      execution: z.string().describe('Serialized representation of the execution results'),
      contextId: z
        .string()
        .optional()
        .describe(
          'Code interpreter context id (python/typescript only); omitted when code runs via Node. Present for correlation; ephemeral runs delete the context after the tool returns.',
        ),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed execution'),
      }),
    ),
  execute: async ({ sandboxId, code, runCodeOpts }) => {
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      const opts = runCodeOpts ?? {};
      const language = opts.language ?? 'python';
      const timeoutMs = opts.timeoutMS;
      const envVars = opts.envs;

      if (language === 'js') {
        const tmpPath = normalizeSandboxPath(
          `.mastra-js-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.js`,
          workspaceRoot,
        );
        await sandbox.filesystem.writeFile(tmpPath, code);
        try {
          const proc = await sandbox.process.execute({
            command: `node ${tmpPath}`,
            timeout: timeoutMsToSeconds(timeoutMs),
            env: envVars,
          });
          return {
            execution: serializeCodeResult({
              language: 'js',
              exitCode: proc.exitCode,
              stdout: proc.stdout,
              stderr: proc.stderr,
            }),
          };
        } finally {
          await sandbox.filesystem.delete({ path: tmpPath, recursive: false }).catch(() => {});
        }
      }

      const leapLang =
        language === 'python' ? CodeLanguage.PYTHON : CodeLanguage.TYPESCRIPT;

      const reuseContextId = opts.contextId;
      const execution = await sandbox.codeInterpreter.execute({
        code,
        language: leapLang,
        envVars,
        timeoutMs,
        contextId: reuseContextId,
      });

      try {
        return {
          execution: serializeCodeResult(execution),
          contextId: execution.contextId,
        };
      } finally {
        if (reuseContextId === undefined) {
          await sandbox.codeInterpreter.deleteContext(execution.contextId).catch(() => {});
        }
      }
    } catch (e) {
      return toError(e);
    }
  },
});

export const readFile = createTool({
  id: 'readFile',
  description: 'Read a file from the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to read the file from'),
    path: z.string().describe('The path to the file to read'),
  }),
  outputSchema: z
    .object({
      content: z.string().describe('The content of the file'),
      path: z.string().describe('The path of the file that was read'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed file read'),
      }),
    ),
  execute: async ({ sandboxId, path }) => {
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      const normalizedPath = normalizeSandboxPath(path, workspaceRoot);
      const content = await sandbox.filesystem.readFile(normalizedPath);
      return { content, path: normalizedPath };
    } catch (e) {
      return toError(e);
    }
  },
});

export const writeFile = createTool({
  id: 'writeFile',
  description: 'Write a single file to the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to write the file to'),
    path: z.string().describe('The path where the file should be written'),
    content: z.string().describe('The content to write to the file'),
  }),
  outputSchema: z
    .object({
      success: z.boolean().describe('Whether the file was written successfully'),
      path: z.string().describe('The path where the file was written'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed file write'),
      }),
    ),
  execute: async ({ sandboxId, path, content }) => {
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      const normalizedPath = normalizeSandboxPath(path, workspaceRoot);
      await sandbox.filesystem.writeFile(normalizedPath, content);
      return { success: true, path: normalizedPath };
    } catch (e) {
      return toError(e);
    }
  },
});

export const writeFiles = createTool({
  id: 'writeFiles',
  description: 'Write multiple files to the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to write the files to'),
    files: z
      .array(
        z.object({
          path: z.string().describe('The path where the file should be written'),
          data: z.string().describe('The content to write to the file'),
        }),
      )
      .describe('Array of files to write, each with path and data'),
  }),
  outputSchema: z
    .object({
      success: z.boolean().describe('Whether all files were written successfully'),
      filesWritten: z.array(z.string()).describe('Array of file paths that were written'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed files write'),
      }),
    ),
  execute: async ({ sandboxId, files }) => {
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      const record: Record<string, string> = {};
      const written: string[] = [];
      for (const file of files) {
        const p = normalizeSandboxPath(file.path, workspaceRoot);
        record[p] = file.data;
        written.push(p);
      }
      await sandbox.filesystem.writeFiles(record);
      return { success: true, filesWritten: written };
    } catch (e) {
      return toError(e);
    }
  },
});

export const listFiles = createTool({
  id: 'listFiles',
  description: 'List files and directories in a path within the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to list files from'),
    path: z
      .string()
      .optional()
      .describe(
        'Directory to list. Omit to list the sandbox workdir (Leap0 getWorkdir, often under /home/user). Use "/" for filesystem root. Relative paths resolve from the workdir.',
      ),
  }),
  outputSchema: z
    .object({
      files: z
        .array(
          z.object({
            name: z.string().describe('The name of the file or directory'),
            path: z.string().describe('The full path of the file or directory'),
            isDirectory: z.boolean().describe('Whether this is a directory'),
          }),
        )
        .describe('Array of files and directories'),
      path: z.string().describe('The path that was listed'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed file listing'),
      }),
    ),
  execute: async ({ sandboxId, path }) => {
    try {
      const { sandbox, normalizedPath } = await getSandboxAndNormalizedListPath(sandboxId, path);
      const listing = await sandbox.filesystem.ls(normalizedPath, { recursive: false });
      return {
        files: listing.items.map((item) => ({
          name: item.name,
          path: item.path,
          isDirectory: item.isDir,
        })),
        path: normalizedPath,
      };
    } catch (e) {
      return toError(e);
    }
  },
});

export const deleteFile = createTool({
  id: 'deleteFile',
  description: 'Delete a file or directory from the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to delete the file from'),
    path: z.string().describe('The path to the file or directory to delete'),
  }),
  outputSchema: z
    .object({
      success: z.boolean().describe('Whether the file was deleted successfully'),
      path: z.string().describe('The path that was deleted'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed file deletion'),
      }),
    ),
  execute: async ({ sandboxId, path }) => {
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      const normalizedPath = normalizeSandboxPath(path, workspaceRoot);
      const info = await sandbox.filesystem.stat(normalizedPath);
      await sandbox.filesystem.delete({ path: normalizedPath, recursive: info.isDir });
      return { success: true, path: normalizedPath };
    } catch (e) {
      return toError(e);
    }
  },
});

export const createDirectory = createTool({
  id: 'createDirectory',
  description: 'Create a directory in the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to create the directory in'),
    path: z.string().describe('The path where the directory should be created'),
  }),
  outputSchema: z
    .object({
      success: z.boolean().describe('Whether the directory was created successfully'),
      path: z.string().describe('The path where the directory was created'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed directory creation'),
      }),
    ),
  execute: async ({ sandboxId, path }) => {
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      const normalizedPath = normalizeSandboxPath(path, workspaceRoot);
      await sandbox.filesystem.mkdir(normalizedPath, { recursive: true });
      return { success: true, path: normalizedPath };
    } catch (e) {
      return toError(e);
    }
  },
});

export const getFileInfo = createTool({
  id: 'getFileInfo',
  description: 'Get detailed information about a file or directory in the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to get file information from'),
    path: z.string().describe('The path to the file or directory to get information about'),
  }),
  outputSchema: z
    .object({
      name: z.string().describe('The name of the file or directory'),
      path: z.string().describe('The full path of the file or directory'),
      isDirectory: z.boolean().describe('Whether this is a directory'),
      size: z.number().describe('The size of the file or directory in bytes'),
      mode: z.string().describe('The file mode / permissions string from the sandbox'),
      owner: z.string().describe('The owner of the file or directory'),
      group: z.string().describe('The group of the file or directory'),
      modifiedTimeMs: z.number().describe('Last modified time as Unix ms (from sandbox mtime)'),
      symlinkTarget: z.string().optional().describe('Symlink target when applicable'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed file info request'),
      }),
    ),
  execute: async ({ sandboxId, path }) => {
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      const normalizedPath = normalizeSandboxPath(path, workspaceRoot);
      const info = await sandbox.filesystem.stat(normalizedPath);
      return {
        name: info.name,
        path: info.path,
        isDirectory: info.isDir,
        size: info.size,
        mode: info.mode,
        owner: info.owner,
        group: info.group,
        modifiedTimeMs: info.mtime * 1000,
        symlinkTarget: info.linkTarget,
      };
    } catch (e) {
      return toError(e);
    }
  },
});

export const checkFileExists = createTool({
  id: 'checkFileExists',
  description: 'Check if a file or directory exists in the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to check file existence in'),
    path: z.string().describe('The path to check for existence'),
  }),
  outputSchema: z
    .object({
      exists: z.boolean().describe('Whether the file or directory exists'),
      path: z.string().describe('The path that was checked'),
      isDirectory: z.boolean().optional().describe('If the path exists, whether it is a directory'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed existence check'),
      }),
    ),
  execute: async ({ sandboxId, path }) => {
    let normalizedPath = path;
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      normalizedPath = normalizeSandboxPath(path, workspaceRoot);
      const exists = await sandbox.filesystem.exists(normalizedPath);
      if (!exists) {
        return { exists: false, path: normalizedPath };
      }
      const info = await sandbox.filesystem.stat(normalizedPath);
      return { exists: true, path: normalizedPath, isDirectory: info.isDir };
    } catch (e) {
      if (e instanceof Leap0NotFoundError) {
        return { exists: false, path: normalizedPath };
      }
      return toError(e);
    }
  },
});

export const getFileSize = createTool({
  id: 'getFileSize',
  description: 'Get the size of a file or directory in the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to get file size from'),
    path: z.string().describe('The path to the file or directory'),
    humanReadable: z
      .boolean()
      .default(false)
      .describe("Whether to return size in human-readable format (e.g., '1.5 KB', '2.3 MB')"),
  }),
  outputSchema: z
    .object({
      size: z.number().describe('The size in bytes'),
      humanReadableSize: z.string().optional().describe('Human-readable size string if requested'),
      path: z.string().describe('The path that was checked'),
      isDirectory: z.boolean().describe('Whether this is a directory'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed size check'),
      }),
    ),
  execute: async ({ sandboxId, path, humanReadable }) => {
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      const normalizedPath = normalizeSandboxPath(path, workspaceRoot);
      const info = await sandbox.filesystem.stat(normalizedPath);
      const humanReadableSize = humanReadable ? formatBytes(info.size) : undefined;
      return {
        size: info.size,
        humanReadableSize,
        path: normalizedPath,
        isDirectory: info.isDir,
      };
    } catch (e) {
      return toError(e);
    }
  },
});

export const watchDirectory = createTool({
  id: 'watchDirectory',
  description:
    '⚠️ NOT SUPPORTED - Directory watching is not exposed by the Leap0 JS SDK in this integration. Do not rely on this tool.',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to watch directory in'),
    path: z.string().describe('The directory path to watch for changes'),
    recursive: z.boolean().default(false).describe('Whether to watch subdirectories recursively'),
    watchDuration: z
      .number()
      .default(30000)
      .describe('How long to watch for changes in milliseconds (default 30 seconds)'),
  }),
  outputSchema: z
    .object({
      watchStarted: z.boolean().describe('Whether the watch was started successfully'),
      path: z.string().describe('The path that was watched'),
      events: z
        .array(
          z.object({
            type: z.string().describe('The type of filesystem event'),
            name: z.string().describe('The name of the file that changed'),
            timestamp: z.string().describe('When the event occurred'),
          }),
        )
        .describe('Array of filesystem events that occurred during the watch period'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed directory watch'),
      }),
    ),
  execute: async () => ({
    error: 'Directory watching is not supported for the Leap0 sandbox provider.',
  }),
});

export const runCommand = createTool({
  id: 'runCommand',
  description: 'Run a shell command in the sandbox',
  inputSchema: z.object({
    sandboxId: z.string().describe('The sandboxId for the sandbox to run the command in'),
    command: z.string().describe('The shell command to execute'),
    envs: z.record(z.string()).optional().describe('Environment variables to set for the command'),
    workingDirectory: z.string().optional().describe('The working directory to run the command in'),
    timeoutMs: z.number().default(30000).describe('Timeout for the command execution in milliseconds'),
    captureOutput: z.boolean().default(true).describe('Whether to capture stdout and stderr output'),
  }),
  outputSchema: z
    .object({
      success: z.boolean().describe('Whether the command executed successfully'),
      exitCode: z.number().describe('The exit code of the command'),
      stdout: z.string().describe('The standard output from the command'),
      stderr: z.string().describe('The standard error from the command'),
      command: z.string().describe('The command that was executed'),
      executionTime: z.number().describe('How long the command took to execute in milliseconds'),
    })
    .or(
      z.object({
        error: z.string().describe('The error from a failed command execution'),
      }),
    ),
  execute: async ({ sandboxId, command, envs, workingDirectory, timeoutMs, captureOutput }) => {
    try {
      const { sandbox, workspaceRoot } = await getSandboxWithWorkdir(sandboxId);
      const startTime = Date.now();
      const timeoutSeconds = timeoutMsToSeconds(timeoutMs ?? 30000);
      const cwd = workingDirectory ? normalizeSandboxPath(workingDirectory, workspaceRoot) : undefined;
      const result = await sandbox.process.execute({
        command,
        cwd,
        timeout: timeoutSeconds,
        env: envs,
      });
      const executionTime = Date.now() - startTime;
      const capture = captureOutput ?? true;
      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: capture ? result.stdout : '',
        stderr: capture ? result.stderr : '',
        command,
        executionTime,
      };
    } catch (e) {
      return toError(e);
    }
  },
});
