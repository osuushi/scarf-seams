import {
  absoluteMode,
  isArc,
  isMove,
  printProgress,
  prohibitedCodes,
  relativeMode,
} from './codes';
import {
  Coordinate,
  MoveMode,
  Point,
  lerp,
  lerpPoints,
  normalize,
  vMul,
} from './util';

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
  currentPosition: Point;
  // We precompute the minimum Z coordinate and then never dip below that. This
  // should help to ensure that we never crash into the bed, so long as the
  // original gcode wouldn't have.
  minZ = Infinity;

  currentMode = 'absolute' as MoveMode;
  inputGcodeLines: string[] = [];
  outputGcodeLines: string[] = [];
  constructor(params: ProcessorParameters) {
    // We must track the current position, because any G0/G1 move is allowed to
    // skip coordinates that aren't changed. We initialize coordinates to
    // infinity until they are known to prevent making invalid moves.
    this.currentPosition = new Point(Infinity, Infinity, Infinity);
    this.params = params;
    this.inputGcodeLines = this.params.gcode.split('\n');
  }

  process(): string {
    this.validate();
    this.findMinZ();
    // We will have to accumulate as we search for loops.
    let positionAtStartOfChunk = this.currentPosition.clone();
    let currentChunk: string[] = [];

    // We call this to dump the current chunk any time we a command that doesn't
    // belong in a closed loop. We then process the chunk, potentially replacing
    // it, if it's a closed loop.
    const dumpChunk = (mightBeLoop = true) => {
      if (!mightBeLoop || this.currentMode === 'relative') {
        // If we're currently in relative mode, we can't be in a loop. We can
        // save some time by skipping the processing.
        this.outputGcodeLines.push(...currentChunk);
      } else {
        const processedChunk = this.replaceChunkIfNeeded(
          positionAtStartOfChunk,
          currentChunk,
        );
        this.outputGcodeLines.push(...processedChunk);
      }
      // Reset the chunk. Note that we always need to know the position at the
      // start of the chunk, because that represents a move that had no
      // extrusion. The loop closes when we return to that position.
      positionAtStartOfChunk = this.currentPosition.clone();
      currentChunk = [];
    };

    for (const line of this.inputGcodeLines) {
      if (this.isCommentOrBlank(line)) {
        // Preserve comments, since some comments are meaningful to some
        // printers, but just write them directly to the output so that they
        // don't get involved with chunk processing.
        //
        // TODO: This is actually making debugging harder. Might be worth fixing
        // this.
        this.outputGcodeLines.push(line);
        continue;
      }

      const command = this.commandForLine(line);
      if (command === absoluteMode) {
        // This is just for robustness. We _should_ be in relative mode, and
        // thus not in a loop, if we're about to switch to absolute. But there's
        // no law that says that has to happen. So we dump the chunk just in
        // case we're already in absolute mode and it turns out to be a loop.
        dumpChunk();
        this.currentMode = 'absolute';
        currentChunk.push(line);
        dumpChunk(false); // this can't be a loop, because we just wrote an absolute mode command
        continue;
      }

      if (command === relativeMode) {
        // We need to dump _before_ we switch to relative mode, because
        dumpChunk();
        this.currentMode = 'relative';
        currentChunk.push(line);
        continue;
      }

      if (isMove(command)) {
        const point = this.pointForLine(line);
        const args = commandArgs(line);
        // Check for conditions that would break a loop.
        if (
          // Moving in the z direction ends any loop
          !approxEqual(point.z, this.currentPosition.z) ||
          // Retracting ends any loop
          this.extrusionForLine(line) < 0 ||
          // Not specifying X or Y ends any loop
          !('X' in args || 'Y' in args)
        ) {
          this.currentPosition = point;
          currentChunk.push(line);
          dumpChunk();
          continue;
        }

        this.currentPosition = point;

        currentChunk.push(line);
        // Note that we might be in relative mode, in which case we can't be in
        // a loop. We don't need to dump here though, because we'll dump after
        // the next "absolute" switch.
        continue;
      }

      if (isArc(command)) {
        // We have no idea what an arc command will do to the position, so we
        // will dump the chunk just in case, and then set the current position's
        // x and y coordinates to Infinity to mark them as unknowns until the
        // next absolute move sets them. Z is not affected by arcs, so we can
        // leave that as its known value.
        currentChunk.push(line);
        dumpChunk(false); // We just wrote an arc command, so it can't be a loop
        this.currentPosition.x = Infinity;
        this.currentPosition.y = Infinity;
        continue;
      }

      if (command === printProgress) {
        // We don't want to deal with print progress commands when processing
        // chunks, so if the current chunk might be a loop, we just dump it
        // directly into the output. This will slightly affect the accuracy of
        // print progress, but it should be a small effect.
        if (this.currentMode === 'absolute') {
          this.outputGcodeLines.push(line);
        } else {
          // If we're in relative mode, we're safe to put the line in the
          // current chunk, since we won't process it.
          currentChunk.push(line);
        }
        continue;
      }

      // Any other command dumps the chunk because it would terminate a loop.
      currentChunk.push(line);
      dumpChunk(false); // Whatever we just appended can't be part of a loop
    }
    dumpChunk();
    return this.outputGcodeLines.join('\n');
  }

  // Determine if the chunk is a closed loop, and if so, modify it so that the
  // end of the loop scarves over the start of the loop.
  replaceChunkIfNeeded(startingPoint: Point, chunk: string[]): string[] {
    if (chunk.length < 2) {
      return chunk;
    }

    // This is defensive. Ideally, we shouldn't have called replaceChunkIfNeeded
    // if we insert a command that breaks the planar extrusion rule
    if (!this.chunkIsPlanarExtrusion(startingPoint, chunk)) {
      return chunk;
    }

    chunk = this.fullyQualifyChunk(startingPoint, chunk);

    // Check if the last point is within tolerance of the starting point. If so, we have a loop.
    const lastPoint = this.pointForLine(chunk[chunk.length - 1]); // note that starting point is irrelevant since we fully qualified the chunk
    const distance = lastPoint.distanceTo(startingPoint);
    if (distance > this.params.loopTolerance) {
      return chunk;
    }

    // Save the original chunk in case we find out that this loop is too short to scarf over
    const originalChunk = [...chunk];
    // Collect up points until we accumulate our overlap distance
    let totalDistance = 0;
    let previousPoint = startingPoint;
    const leadingLines: string[] = [];
    while (true) {
      const nextLine = chunk.shift();
      if (nextLine == null) {
        // We ran out of lines before we accumulated enough distance. We can't
        // scarf over this loop.
        return originalChunk;
      }
      leadingLines.push(nextLine);
      const nextPoint = this.pointForLine(nextLine);
      totalDistance += nextPoint.distanceTo(previousPoint);
      if (totalDistance > this.params.overlap) {
        break;
      }
      previousPoint = nextPoint;
    }

    // We've now partitioned the chunk into leading lines, which will overshoot
    // the overlap by one command, and the rest of our chunk. We now need to
    // determine how much we overshot by and split the last line segment.
    const overshoot = totalDistance - this.params.overlap;
    // Have a little tolerance here just to avoid degenerate tiny segments.
    if (overshoot > 0.01) {
      const lastLeadingLine = leadingLines[leadingLines.length - 1];
      const finalPoint = this.pointForLine(lastLeadingLine);

      // Move back from the last point by the overshoot distance
      const vector = normalize(previousPoint.subtract(finalPoint));
      const newPoint = finalPoint.addVector(vMul(vector, overshoot));

      // Since extrusion is relative, we need to divide the extrusion for the
      // end point proportionally along the split.
      const newPointDistance = previousPoint.distanceTo(newPoint);
      const finalPointDistance = previousPoint.distanceTo(finalPoint);

      const extrusionPerDistance =
        this.extrusionForLine(lastLeadingLine) / finalPointDistance;

      const newPointExtrusion = extrusionPerDistance * newPointDistance;

      const finalPointExtrusion =
        extrusionPerDistance * (finalPointDistance - newPointDistance);

      // Now we can finally create our fully qualified command lines
      const newLine = `G1 X${newPoint.x} Y${newPoint.y} Z${newPoint.z} E${newPointExtrusion}`;

      // There might be a feed rate on the final line, so we need to preserve that
      const existingFinalFeed = commandArgs(lastLeadingLine).F;
      const newFinalLine = maybeAddFeed(
        `G1 X${finalPoint.x} Y${finalPoint.y} Z${finalPoint.z} E${finalPointExtrusion}`,
        existingFinalFeed,
      );

      // Move the final line to the remainder of the chunk
      chunk.unshift(newFinalLine);

      // Replace the last line of the leading lines with the new line
      leadingLines[leadingLines.length - 1] = newLine;
    }

    // We now have the leading lines that make up our overlapping section, but
    // they need to be subdivided to the target resolution so that we can
    // smoothly ramp.
    const overlapSection = this.subdivideChunk(startingPoint, leadingLines);

    const startingOverlap = this.applyTaper(
      startingPoint,
      overlapSection,
      'start',
    );

    const endingOverlap = this.applyTaper(lastPoint, chunk, 'end');
    return [
      '; Scarfing loop:',
      ...startingOverlap,
      ...chunk,
      ...endingOverlap,
      '; Loop scarfed over',
    ];
  }

  applyTaper(
    startingPoint: Point,
    overlapSection: string[],
    side: 'start' | 'end',
  ) {
    const startZ = Math.max(
      startingPoint.z - this.params.layerHeight,
      this.minZ,
    );
    const endZ = startingPoint.z;

    // We cannot trust the subdivision process to give evenly spaced points,
    // since the original gcode could have had short segments.
    const totalDistance = this.params.overlap;
    let t = 0;
    let previousPoint = startingPoint;
    const result = [];
    for (const line of overlapSection) {
      const point = this.pointForLine(line);
      const distance = point.distanceTo(previousPoint);
      const distanceFraction = distance / totalDistance;
      t += distanceFraction;
      // The overlap looks like this:
      //  _________   __________
      //           \ \
      //            \ \
      //    start    \ \    end
      //              \ \
      //               \ \
      // ---------------  ---------
      //
      // Where the nozzle is moving to the left and circling back around. Notice
      // while the height tapers at the start, the end is flat on top.
      // Therefore, there is no Z taper on the end sequence, but there is on the
      // start.
      const z = side === 'start' ? lerp(startZ, endZ, t) : endZ;
      const eParameter = side === 'start' ? t : 1 - t; // The extrusion ramps up for the start and down for the end.
      const e = this.extrusionForLine(line) * eParameter; // taper extrusion
      const feedRate = commandArgs(line).F;
      const newLine = maybeAddFeed(
        `G1 X${point.x} Y${point.y} Z${z} E${e}`,
        feedRate,
      );
      result.push(newLine);
      previousPoint = point;
    }
    return result;
  }

  subdivideChunk(startingPoint: Point, chunk: string[]): string[] {
    const result = [];
    const prevPoint = startingPoint;
    const stepDistance = this.params.taperResolution;
    for (const line of chunk) {
      const curPoint = this.pointForLine(line);
      const curE = this.extrusionForLine(line);
      const maybeFeedRate = commandArgs(line).F;
      const curDistance = curPoint.distanceTo(prevPoint);
      const steps = Math.ceil(curDistance / stepDistance);

      // We don't interpolate extrusion, but instead divide it evenly among the steps, since it's relative
      const ePerStep = curE / steps;
      for (let i = 0; i < steps; i++) {
        const u = (i + 1) / steps; // The previous point was always covered by the previous loop iteration
        const newPoint = lerpPoints(prevPoint, curPoint, u);

        const newLine = maybeAddFeed(
          `G1 X${newPoint.x} Y${newPoint.y} Z${newPoint.z} E${ePerStep}`,
          maybeFeedRate,
        );
        result.push(newLine);
      }
    }
    return result;
  }

  // Convert the chunk into fully qualified moves (moves that specify X, Y,
  // and Z).
  fullyQualifyChunk(startingPoint: Point, chunk: string[]): string[] {
    return chunk.map((line) => {
      const point = this.pointForLine(line, startingPoint);
      const extrusion = this.extrusionForLine(line);
      const feedRate = commandArgs(line).F;
      const fullCommand = maybeAddFeed(
        `G1 X${point.x} Y${point.y} Z${point.z} E${extrusion}`,
        feedRate,
      );

      startingPoint = point;
      return fullCommand;
    });
  }

  // Check that a chunk of commands contains only
  chunkIsPlanarExtrusion(startingPoint: Point, chunk: string[]): boolean {
    // All commands are moves
    if (!chunk.every((l) => isMove(this.commandForLine(l)))) {
      return false;
    }
    // No command changes the Z coordinate
    if (
      chunk.some((l) => !approxEqual(this.pointForLine(l).z, startingPoint.z))
    ) {
      return false;
    }
    // No command has negative extrusion
    if (chunk.some((l) => this.extrusionForLine(l) < 0)) {
      return false;
    }
    return true;
  }

  findMinZ() {
    let moveMode: MoveMode | undefined = undefined;
    let minZ = Infinity;
    for (const line of this.inputGcodeLines) {
      const cmd = this.commandForLine(line);
      // We emulate as little of the machine as possible during this pass, but
      // we do have to know if we're in absolute or relative mode, or we will
      // interpret the move codes incorrectly.
      if (cmd === absoluteMode) {
        moveMode = 'absolute';
        continue;
      }

      if (cmd === relativeMode) {
        moveMode = 'relative';
        continue;
      }

      if (moveMode === 'absolute' && isMove(cmd)) {
        // Note that X and Y will be infinite here, since we're not
        // accumulating. Z might also be infinite, but that's fine with
        // Math.min.
        const point = this.pointForLine(line);
        minZ = Math.min(minZ, point.z);
      }
    }
    if (Number.isFinite(minZ)) {
      this.minZ = minZ;
    } else {
      throw new Error('Could not find minimum Z coordinate');
    }
  }

  pointForLine(line: string, startingPoint = this.currentPosition) {
    const args = commandArgs(line);
    const point = startingPoint.clone();
    for (const coord of ['x', 'y', 'z'] as Coordinate[]) {
      const value = args[coord.toUpperCase()];
      if (value) {
        switch (this.currentMode) {
          case 'absolute':
            point[coord] = value;
            break;
          case 'relative':
            point[coord] += value;
            break;
        }
      }
    }
    return point;
  }

  extrusionForLine(line: string): number {
    const args = commandArgs(line);
    return args.E ?? 0;
  }

  validate(): void {
    for (const line of this.inputGcodeLines) {
      if (this.isCommentOrBlank(line)) {
        continue;
      }

      const command = this.commandForLine(line);
      if (command in prohibitedCodes) {
        throw new Error(
          `Prohibited code: ${command} - ${
            prohibitedCodes[command as keyof typeof prohibitedCodes]
          }`,
        );
      }
      if (command === 'G92') {
        // Reset commands are dangerous, but only if they change the Z coordinate.
        // We don't want to prohibit them if they don't.
        const args = commandArgs(line);
        if (args.Z != null) {
          throw new Error(
            'Prohibited code: G92 with Z argument. Z coordinate resets are not handled, and could cause build surface crashes.',
          );
        }
      }
    }
  }

  isCommentOrBlank(line: string): boolean {
    return line.startsWith(';') || line.trim() === '';
  }

  commandForLine(line: string): string {
    const parts = splitCommand(line);
    const command = parts[0];
    return command;
  }
}

const tolerance = 0.0001;
function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < tolerance;
}

// Split a command and also stop at any comment
function splitCommand(command: string): string[] {
  const commandAndMaybeComment = command.split(';');
  const commandParts = commandAndMaybeComment[0].split(' ');
  return commandParts;
}

function commandArgs(command: string): Record<string, number> {
  const parts = splitCommand(command);
  const argParts = parts.slice(1);
  const args: Record<string, number> = {};
  for (const argPart of argParts) {
    if (argPart === '') continue;
    const key = argPart[0].toUpperCase();
    const value = parseFloat(argPart.slice(1));
    args[key] = value;
  }
  return args;
}

function maybeAddFeed(line: string, feed: number | undefined): string {
  if (feed == null) return line;
  return `${line} F${feed}`;
}
