export type ProcessorParameters = {
  gcode: string;
  layerHeight: number;
  overlap: number;
  loopTolerance: number;
  taperResolution: number;
};

export function process(params: ProcessorParameters): string {
  const processor = new Processor(params);
  return processor.process();
}

class Processor {
  params: ProcessorParameters;
  constructor(params: ProcessorParameters) {
    this.params = params;
  }

  process(): string {
    throw new Error("Not implemented");
  }
}
