// `discoverInstructionFiles` + `renderInstructionsSection` (and the
// `InstructionFile` type + budget constants) moved to `@xandreed/sdk-core`
// (`usecases/discoverInstructionFiles.ts`) so drivers outside this package
// (e.g. `@xandreed/smith`) can build the instruction prompt section without
// importing the CLI. Re-exported here so existing
// `import … from "./discoverInstructionFiles.js"` consumers are unchanged.
export {
  discoverInstructionFiles,
  MAX_INSTRUCTION_FILE_CHARS,
  MAX_TOTAL_INSTRUCTION_CHARS,
  renderInstructionsSection,
  type InstructionFile,
} from "@xandreed/sdk-core"
