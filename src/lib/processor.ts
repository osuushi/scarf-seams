import {
  GcodeCommand,
  MoveCommand,
  codes,
  isMoveCommand,
  parseCommand,
  stringifyCommand,
} from './GcodeCommand';
import { GcodeVm } from './GcodeVm';
import { MoveMode, Point, normalize, vMul } from './util';

export type ProcessorParameters = {
  gcode: string;
  layerHeight: number;
  overlap: number;
  loopTolerance: number;
  taperResolution: number;
  seamGap: number;
};

export function process(params: ProcessorParameters): string {
  const processor = new Processor(params);
  return processor.process();
}

// We can't taper to make an entire loop overlap. Instead, we'll limit the
// overlap to a third of the loop length. This is a pretty arbitrary choice, and
// maybe should be a parameter.
const MAX_OVERLAP_LOOP_FRACTION = 1 / 3;

// Error type for when we find a coordinate system change in a taper section.
// In these cases, we want to just skip the loop with a console warning
class CoordinateSystemChangeError extends Error {
  constructor() {
    super('Coordinate system change in taper section');
  }
}

class Processor {
  params: ProcessorParameters;
  currentPosition: Point;
  // We precompute the minimum Z coordinate and then never dip below that. This
  // should help to ensure that we never crash into the bed, so long as the
  // original gcode wouldn't have.
  //
  // No matter what, we won't go below 0. Bambu gcode, for example,
  // intentionally "crashes" the nozzle into the bed early on to clean it.
  minSafeZ = 0;

  currentMode = 'absolute' as MoveMode;
  // The input lines split from the gcode. This is not modified
  inputGcodeLines: string[] = [];
  outputGcodeLines: string[] = [];

  // This is modified as we work, popping lines off as they're processed. It is
  // copied from inputGcodeLines at the start of the process method. Note that
  // the buffer is reversed, so that repeatedly popping the elements presents
  // them in the original order.
  inputStack: GcodeCommand[] = [];
  constructor(params: ProcessorParameters) {
    // We must track the current position, because any G0/G1 move is allowed to
    // skip coordinates that aren't changed. We initialize coordinates to
    // infinity until they are known to prevent making invalid moves.
    this.currentPosition = new Point(Infinity, Infinity, Infinity);
    this.params = params;
    this.inputGcodeLines = this.params.gcode.split('\n');
  }

  process(): string {
    this.findMinimumSafeZ();
    let vm = new GcodeVm();
    // Create the inputStack. This is so that we don't have to track indices in
    // this fairly complex process. Instead, we can just consume lines by
    // popping. The only annoying thing is that we have to reverse so that we
    // can shift off the end of the array, since most JS engines have poor
    // performance when shifting off the front.
    this.inputStack = [];
    for (const line of this.inputGcodeLines) {
      this.inputStack.push(parseCommand(line));
    }
    this.inputStack.reverse();

    // In our main loop, we simply pop off the next line and process it. If we
    // never meet the condition for a closed loop, we will end up simply passing
    // through the entire file as is.
    while (true) {
      const currentCommand = this.inputStack.pop();
      if (!currentCommand) break;
      if (this.isExtrusionStart(vm, currentCommand)) {
        // Get a list of commands up until the point where we stop extruding.
        // This list may not be the original list of commands, but the extrusion
        // sequence will still be consumed. This list also may contain non-move
        // commands.
        const extrusionSequence = this.nextExtrusionSequence(
          vm,
          currentCommand,
        );

        for (const command of extrusionSequence) {
          vm = vm.executeCommand(command);
          this.outputGcodeLines.push(stringifyCommand(command));
        }
      } else {
        vm = vm.executeCommand(currentCommand);
        this.outputGcodeLines.push(stringifyCommand(currentCommand));
      }
    }
    return this.outputGcodeLines.join('\n');
  }

  // Consume commands from the input stack until we
  nextExtrusionSequence(
    vm: GcodeVm,
    firstCommand: GcodeCommand,
  ): GcodeCommand[] {
    // Consume the entire original continuous extrusion sequence. Note that
    // these commands may have non-moves mixed in, which must be handled.
    const originalExtrusionSequence = this.consumeWhileExtruding(
      vm,
      firstCommand,
    );

    if (!this.isLoop(vm, originalExtrusionSequence)) {
      // This is not a closed loop. Just return the original sequence
      return originalExtrusionSequence;
    }

    const totalLength = this.calculateSequenceLength(
      vm,
      originalExtrusionSequence,
    );

    if (totalLength < this.params.taperResolution) {
      // The sequence is too short to taper. Just return the original sequence
      return originalExtrusionSequence;
    }

    const overlap = Math.min(
      this.params.overlap,
      MAX_OVERLAP_LOOP_FRACTION * totalLength,
    );

    try {
      return this.createOverlappedSequence({
        vm,
        originalExtrusionSequence,
        overlap,
      });
    } catch (err) {
      if (err instanceof CoordinateSystemChangeError) {
        // eslint-disable-next-line no-console
        console.warn(err);
        // eslint-disable-next-line no-console
        console.warn('Passthrough for loop with illegal move inside taper');
        // Skip the loop and just return the original sequence
        return originalExtrusionSequence;
      } else {
        throw err;
      }
    }
  }

  createOverlappedSequence({
    vm,
    originalExtrusionSequence,
    overlap,
  }: {
    vm: GcodeVm;
    originalExtrusionSequence: GcodeCommand[];
    overlap: number;
  }): GcodeCommand[] {
    const { taperSection, nonTaperSection } = this.splitTaperSection({
      vm,
      sequence: originalExtrusionSequence,
      overlap,
    });

    const dividedTaperSection = this.divideSequence(
      vm,
      taperSection,
      this.params.taperResolution,
    );

    const startingTaper = this.makeStartingTaper(
      vm,
      dividedTaperSection,
      overlap,
    );
    // Execute the starting and non taper sections before computing the ending taper
    for (const command of [...startingTaper, ...nonTaperSection]) {
      vm = vm.executeCommand(command);
    }
    const endingTaper = this.makeEndingTaper(vm, dividedTaperSection, overlap);
    return [
      {
        type: 'comment',
        comment: 'Beginning of tapered loop',
      },
      ...startingTaper,
      ...nonTaperSection,
      ...endingTaper,
      {
        type: 'comment',
        comment: 'End of tapered loop',
      },
    ];
  }

  // Insert moves so that each command moves by approximately the
  // taperResolution. Non-move commands should stay where they are relative to
  // the corresponding segments, e.g.
  //
  //  [move_a, non-move, move_b]
  //
  //  becomes
  //
  // [move_a_1, ... move_a_n, non-move, move_b_1, ... move_b_n]
  divideSequence(
    vm: GcodeVm,
    sequence: GcodeCommand[],
    resolution: number,
  ): GcodeCommand[] {
    const results = [];
    for (const curCommand of sequence) {
      const nextVm = vm.executeCommand(curCommand);
      if (!isMoveCommand(curCommand)) {
        vm = nextVm;
        results.push(curCommand);
        continue;
      }
      const dividedMoves = this.divideMove(vm, curCommand, resolution);
      results.push(...dividedMoves);
      vm = nextVm;
    }
    return results;
  }

  // Divide a single move (given a VM state) into moves of length no greater
  // than `resolution`.
  divideMove(
    vm: GcodeVm,
    curCommand: MoveCommand,
    resolution: number,
  ): GcodeCommand[] {
    const nextVm = vm.executeCommand(curCommand);
    const results: GcodeCommand[] = [
      {
        type: 'comment',
        comment: 'Beginning of divided move',
      },
    ];
    const startPoint = vm.physicalPosition;
    const endPoint = nextVm.physicalPosition;
    const distance = startPoint.distanceTo(endPoint);
    const stepCount = Math.ceil(distance / resolution);
    // Adjust the resolution to fit an integer number of steps
    const actualResolution = distance / stepCount;
    const stepVector = vMul(
      normalize(endPoint.subtract(startPoint)),
      actualResolution,
    );
    // Divide the extrusion equally between the steps
    const stepExtrusion = (nextVm.extrusion - vm.extrusion) / stepCount;

    // Note that since no coordinate system changing commands can happen during
    // this loop, we can skip updating the VM
    for (let i = 0; i < stepCount; i++) {
      const stepPoint = startPoint.addVector(vMul(stepVector, i));
      const logicalPosition = vm.convertPhysicalPositionToLogical(stepPoint);
      const stepCommand: MoveCommand = {
        ...curCommand,
        args: {
          ...curCommand.args,
          X: logicalPosition.x,
          Y: logicalPosition.y,
          Z: logicalPosition.z,
          E: stepExtrusion,
        },
      };
      results.push(stepCommand);
    }
    results.push({
      type: 'comment',
      comment: 'End of divided move',
    });
    return results;
  }

  // Given a taper section, create the starting taper. The extrusion will be
  // multiplied by a ramp from zero to one, and the z index will ramp according
  // to the layer height parameter. It is assumed that the input taper section
  // has already been divided according to the target resolution.
  makeStartingTaper(
    vm: GcodeVm,
    taperSection: GcodeCommand[],
    overlap: number,
  ): GcodeCommand[] {
    let startPoint = vm.physicalPosition;
    let accumDistance = 0;
    return taperSection.map((curCommand) => {
      // The VM state if we had used the original point
      const nextVm = vm.executeCommand(curCommand);
      if (!isMoveCommand(curCommand)) {
        vm = nextVm;
        return curCommand;
      }

      const nextPoint = nextVm.physicalPosition;
      accumDistance += startPoint.distanceTo(nextPoint);
      startPoint = nextPoint;

      const t = accumDistance / overlap;
      const extrusion = t * (nextVm.extrusion - vm.extrusion);
      const zOffset = (1 - t) * this.params.layerHeight;
      const newZ = Math.max(nextVm.physicalPosition.z - zOffset, this.minSafeZ);

      const newPoint = new Point(nextPoint.x, nextPoint.y, newZ);
      const logicalPosition = vm.convertPhysicalPositionToLogical(newPoint);
      const newCommand = {
        ...curCommand,
        args: {
          ...curCommand.args,
          Z: logicalPosition.z,
          E: extrusion,
        },
      };
      // We do not want to update the VM with the new command, since we've
      // changed the z position
      vm = nextVm;
      return newCommand;
    });
  }

  // This is very similar to makeStartingTaper, but we ramp the extrusion down
  // instead of up, and we don't touch the Z coordinate. We also skip any
  // non-moves, rather than duplicating them.
  makeEndingTaper(
    vm: GcodeVm,
    taperSection: GcodeCommand[],
    overlap: number,
  ): GcodeCommand[] {
    let startPoint = vm.physicalPosition;
    let accumDistance = 0;
    const results = [];
    for (const curCommand of taperSection) {
      // The VM state if we had used the original point
      const nextVm = vm.executeCommand(curCommand);
      if (!isMoveCommand(curCommand)) {
        // Best effort to protect from weird edge cases where a
        if (curCommand.type === 'simple') {
          switch (curCommand.command) {
            case codes.setPosition:
            case codes.relative:
            case codes.home:
              throw new CoordinateSystemChangeError();
          }
        }

        vm = nextVm;
        continue;
      }

      const nextPoint = nextVm.physicalPosition;
      accumDistance += startPoint.distanceTo(nextPoint);
      startPoint = nextPoint;

      const t = accumDistance / overlap;
      const extrusion = (1 - t) * (nextVm.extrusion - vm.extrusion);
      const logicalPosition = vm.convertPhysicalPositionToLogical(nextPoint);
      const newCommand = {
        ...curCommand,
        args: {
          ...curCommand.args,
          X: logicalPosition.x,
          Y: logicalPosition.y,
          Z: logicalPosition.z,
          E: extrusion,
        },
      };
      results.push(newCommand);
      vm = nextVm;
    }

    return results;
  }

  splitTaperSection({
    vm,
    sequence,
    overlap,
  }: {
    vm: GcodeVm;
    sequence: GcodeCommand[];
    overlap: number;
  }): { taperSection: GcodeCommand[]; nonTaperSection: GcodeCommand[] } {
    let accumDistance = 0;
    let prevPoint = vm.physicalPosition;
    const taperSection: GcodeCommand[] = [];
    const nonTaperSection: GcodeCommand[] = [];
    let isTapering = true;
    // accumulate the taper section
    for (const curCommand of sequence) {
      const nextVm = vm.executeCommand(curCommand);
      if (isTapering) {
        // Pass through non move commands
        if (!isMoveCommand(curCommand)) {
          taperSection.push(curCommand);
          continue;
        }

        const nextPoint = nextVm.physicalPosition;
        const segmentLength = prevPoint.distanceTo(nextPoint);
        if (accumDistance + segmentLength < overlap) {
          // We're still in the taper section
          accumDistance += segmentLength;
          // Pass through the command
          taperSection.push(curCommand);
        } else {
          isTapering = false;
          const splitDistance = overlap - accumDistance;
          // We've overshot the overlap. This means we now need to create a
          // synthetic point between the previous point and this point.
          const vDirection = normalize(nextPoint.subtract(prevPoint));
          const splitPoint = prevPoint.addVector(
            vMul(vDirection, splitDistance),
          );
          // We have to replace the end point with a synthetic point too, to
          // share the extrusion amount between the two points.
          const totalExtrusion = nextVm.extrusion - vm.extrusion;
          const extrusionRatio = splitDistance / segmentLength;
          const splitExtrusion = totalExtrusion * extrusionRatio;
          // Since extrusion is relative, we can just subtract off whatever we
          // extruded at the split point.
          const adjustedEndExtrusion = totalExtrusion - splitExtrusion;

          // Get the logical position at the split point. Since we're assuming
          // absolute positioning, we can just move to this point.
          const splitLogicalPosition =
            vm.convertPhysicalPositionToLogical(splitPoint);

          // Create the split point move command
          const splitPointMove: MoveCommand = {
            type: 'simple',
            command: curCommand.command,
            args: {
              ...curCommand.args,
              X: splitLogicalPosition.x,
              Y: splitLogicalPosition.y,
              Z: splitLogicalPosition.z,
              E: splitExtrusion,
            },
          };

          taperSection.push(splitPointMove);

          // The end point is _not_ part of the taper section, and must have its
          // extrusion adjusted.
          const adjustedEndPoint: MoveCommand = {
            ...curCommand,
            args: {
              ...curCommand.args,
              E: adjustedEndExtrusion,
            },
          };
          nonTaperSection.push(adjustedEndPoint);
        }
        prevPoint = nextPoint;
        vm = nextVm;
      } else {
        // We just pass through the rest of the commands
        nonTaperSection.push(curCommand);
        vm = nextVm;
      }
    }
    return { taperSection, nonTaperSection };
  }

  // Run the gcode sequence and see if we end up back at the start point
  isLoop(vm: GcodeVm, sequence: GcodeCommand[]): boolean {
    // Never try to process as a loop if we don't know our logical position.
    // This currently happens before homing, and if we've had an arc command
    // since the last time each coordinate was set absolutely, since those are
    // currently unsupported by the VM.
    if (!vm.logicalPositionKnown) return false;

    const startPoint = vm.physicalPosition;
    for (const command of sequence) {
      vm = vm.executeCommand(command);
    }
    const endPoint = vm.physicalPosition;
    return endPoint.distanceTo(startPoint) < this.params.loopTolerance;
  }

  calculateSequenceLength(vm: GcodeVm, sequence: GcodeCommand[]): number {
    let prevPoint = vm.physicalPosition;
    let totalDistance = 0;
    for (const command of sequence) {
      vm = vm.executeCommand(command);
      const nextPoint = vm.physicalPosition;
      const distance = prevPoint.distanceTo(nextPoint);
      totalDistance += distance;
      prevPoint = nextPoint;
    }
    return totalDistance;
  }

  // Returns all the commands up until the point where we stop extruding,
  // consuming them from the stack. This may include non-move commands.
  consumeWhileExtruding(
    vm: GcodeVm,
    firstCommand: GcodeCommand,
  ): GcodeCommand[] {
    const result = [firstCommand];
    let speculativeVm = vm.executeCommand(firstCommand);
    while (true) {
      const nextCommand = this.inputStack.pop();
      if (!nextCommand) break;
      speculativeVm = speculativeVm.executeCommand(nextCommand);
      if (speculativeVm.didExtrudeOnLastMove) {
        result.push(nextCommand);
      } else {
        // This was a non-extruding move. Put it back and stop consuming
        this.inputStack.push(nextCommand);
        break;
      }
    }
    return result;
  }

  isExtrusionStart(vm: GcodeVm, command: GcodeCommand): boolean {
    const nextVm = vm.executeCommand(command);
    return nextVm.extrusion > vm.extrusion;
  }

  // Do a dry run through the gcode to find the minimum Z coordinate set in the
  // original code. Assuming the original gcode doesn't crash the bed, we can
  // protect against crashes by ensuring our emitted gcode never goes below this
  // value
  findMinimumSafeZ() {
    let vm = new GcodeVm();
    for (const line of this.inputGcodeLines) {
      vm = vm.executeLine(line);
      // We can't query the z coordinate if the logical position is unknown
      if (!vm.logicalPositionKnown) continue;

      this.minSafeZ = Math.min(this.minSafeZ, vm.physicalPosition.z);
    }

    if (!Number.isFinite(this.minSafeZ)) {
      throw new Error('Could not find minimum safe Z coordinate');
    }
  }
}
