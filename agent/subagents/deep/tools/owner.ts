import { disableTool } from "eve/tools";

// Recall is a memory lifecycle hook, not this tool, so the subagent still reads the owner's memory;
// only root writes it, from what the owner says in chat.
export default disableTool();
