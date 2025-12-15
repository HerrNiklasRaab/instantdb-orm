import { configure } from "mobx";
configure({ enforceActions: "never" });

// Re-export everything from object-graph
export * from "./object-graph/index";
