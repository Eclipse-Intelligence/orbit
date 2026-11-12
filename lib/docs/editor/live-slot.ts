import { Annotation, Compartment } from "@codemirror/state";

export const liveSlot = new Compartment();

export const external = Annotation.define<boolean>();
