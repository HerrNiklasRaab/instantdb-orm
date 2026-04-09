import type { Model } from "./Model";

const callbacks = new Set<(model: Model) => void>();

export function addOnNewModel(callback: (model: Model) => void): void {
  callbacks.add(callback);
}

export function removeOnNewModel(callback: (model: Model) => void): void {
  callbacks.delete(callback);
}

export function notifyNewModel(model: Model): void {
  for (const callback of callbacks) {
    callback(model);
  }
}
