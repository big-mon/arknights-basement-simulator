import { generateAssignmentPlan } from "../lib/optimizer";
import type { AppState } from "../types";

self.onmessage = (event: MessageEvent<AppState>) => {
  self.postMessage(generateAssignmentPlan(event.data));
};
