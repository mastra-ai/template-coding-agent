import * as e2bTools from './e2b';
import * as daytonaTools from './daytona/tools';
import * as leap0Tools from './leap0/tools';

type SandboxProvider = 'daytona' | 'e2b' | 'leap0';

function getProvider(): SandboxProvider {
  if (process.env.DAYTONA_API_KEY) {
    return 'daytona';
  }
  if (process.env.E2B_API_KEY) {
    return 'e2b';
  }
  if (process.env.LEAP0_API_KEY) {
    return 'leap0';
  }
  throw new Error(
    'No sandbox provider configured. Please set DAYTONA_API_KEY, E2B_API_KEY, or LEAP0_API_KEY environment variable.',
  );
}

const provider = getProvider();

// Using 'as any' because providers have slightly different output schemas for some tools.
const pickTool = (daytonaTool: any, e2bTool: any, leap0Tool: any) => {
  if (provider === 'daytona') {
    return daytonaTool;
  }
  if (provider === 'e2b') {
    return e2bTool;
  }
  return leap0Tool;
};

export const createSandbox = pickTool(
  daytonaTools.createSandbox,
  e2bTools.createSandbox,
  leap0Tools.createSandbox,
);
export const runCode = pickTool(daytonaTools.runCode, e2bTools.runCode, leap0Tools.runCode);
export const readFile = pickTool(daytonaTools.readFile, e2bTools.readFile, leap0Tools.readFile);
export const writeFile = pickTool(daytonaTools.writeFile, e2bTools.writeFile, leap0Tools.writeFile);
export const writeFiles = pickTool(daytonaTools.writeFiles, e2bTools.writeFiles, leap0Tools.writeFiles);
export const listFiles = pickTool(daytonaTools.listFiles, e2bTools.listFiles, leap0Tools.listFiles);
export const deleteFile = pickTool(daytonaTools.deleteFile, e2bTools.deleteFile, leap0Tools.deleteFile);
export const createDirectory = pickTool(
  daytonaTools.createDirectory,
  e2bTools.createDirectory,
  leap0Tools.createDirectory,
);
export const getFileInfo = pickTool(daytonaTools.getFileInfo, e2bTools.getFileInfo, leap0Tools.getFileInfo);
export const checkFileExists = pickTool(
  daytonaTools.checkFileExists,
  e2bTools.checkFileExists,
  leap0Tools.checkFileExists,
);
export const getFileSize = pickTool(daytonaTools.getFileSize, e2bTools.getFileSize, leap0Tools.getFileSize);
export const watchDirectory = pickTool(
  daytonaTools.watchDirectory,
  e2bTools.watchDirectory,
  leap0Tools.watchDirectory,
);
export const runCommand = pickTool(daytonaTools.runCommand, e2bTools.runCommand, leap0Tools.runCommand);
