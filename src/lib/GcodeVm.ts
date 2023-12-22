import dedent from 'ts-dedent';
import { Point } from './util';
import { GcodeCommand, SimpleCommand, parseCommand } from './GcodeCommand';

// A GcodeVM is a virtual machine which executes Marlin gcode commands and
// tracks the printer's physical and logical state. The printer is immutable;
// executing a command returns a new printer with the updated state. This makes
// it ideal for speculative execution of gcode instructions and inspection of
// the results.
//
// Note that not all gcode commands are supported. In most cases, these commands
// are simply ignored, since they don't affect the state that the VM tracks. A
// notable exception is arc commands, which are not emulated. When the VM
// executes an arc command, the resulting printer will have the logical X and Y
// position set to Infinity, indicating that their values are now unknown. This
// means that the VM cannot be used to process arcs. However, gcode which uses
// arc commands during setup will work fine, so long as there is a homing
// command or an absolute move for both X and Y (or individual moves), before
// the logical or physical position needs to be queried. Note, though, that if a
// G92 (set position) tries to set the logical position while the current
// logical position is unknown, this will lead to the physical offset being
// undefined. If you request the physical position while in this state, an error
// will be thrown.
export class GcodeVm {
  positionMode: MoveMode = 'absolute';
  extrusionMode: MoveMode = 'relative';

  // The position according to how the printer sees the world
  logicalPosition: Point = Point.unknown;
  // The absolute extrusion amount as the printer sees it.
  extrusion: number = 0;
  // The current feed rate
  feedRate: number = 0;

  didExtrudeOnLastMove: boolean = false;

  // The offset between "physical" coordinates and printer coordinates. This is
  // modified by two commands:
  //  - G28: Home the printer. This will zero both the position and the offset.
  //  - G92: Set position. This "declares" that the print head is at some
  //    position (or subset of coordinates) without moving it. When this
  //    happens, we have to change the offset so that the computed value of
  //    physicalPosition is unchanged, but the position is updated to the value
  //    specified.
  physicalOffset: Point = Point.zero;
  physicalEOffset: number = 0;

  get physicalPosition(): Point {
    // Check for invalid physical offset
    if (!this.logicalPosition.isFinite()) {
      throw new Error(
        dedent`
          Cannot get physical position when logical position is unknown.
          The gcode may have called G92 (set position) while the logical
          position was unknown, either before homing or after an arc command.
        `,
      );
    }

    return this.logicalPosition.addVector(this.physicalOffset.toVector());
  }

  get physicalExtrusion(): number {
    return this.extrusion + this.physicalEOffset;
  }

  executeLine(gcodeLine: string): GcodeVm {
    const command = parseCommand(gcodeLine);
    return this.executeCommand(command);
  }

  executeCommand(command: GcodeCommand): GcodeVm {
    switch (command.type) {
      case 'simple':
        return this.executeSimpleCommand(command);
      case 'comment':
        return this;
      case 'unknown':
        return this;
    }
  }

  executeSimpleCommand(command: SimpleCommand): GcodeVm {
    switch (command.command) {
      case 'G0':
      case 'G1':
        return this.executeMoveCommand(command);
      case 'G2':
      case 'G3':
        return this.executeArcCommand();
      case 'G28':
        return this.executeHomeCommand(command);
      case 'G90':
        return this.executeSetPositionModeCommand(command);
      case 'G91':
        return this.executeSetPositionModeCommand(command);
      case 'G92':
      case 'G92.1':
        return this.executeSetPositionCommand(command);
      case 'M82':
        return this.executeSetExtrusionModeCommand(command);
      case 'M83':
        return this.executeSetExtrusionModeCommand(command);
    }
  }

  executeSetExtrusionModeCommand(command: SimpleCommand): GcodeVm {
    const clone = this.clone();
    switch (command.command) {
      case 'M82':
        clone.extrusionMode = 'absolute';
        break;
      case 'M83':
        clone.extrusionMode = 'relative';
        break;
    }
    return clone;
  }

  executeSetPositionCommand(command: SimpleCommand): GcodeVm {
    const { args } = command;
    const clone = this.clone();

    for (const axis of ['x', 'y', 'z'] as const) {
      const argsKey = axis.toUpperCase();
      if (argsKey in args) {
        // The set position command declares that the logical position is now
        // whatever coordinate we were given. We need to adjust the physical
        // offset so that it remains the same when we change the logical
        // position.

        const declaredPosition = args[argsKey];
        const delta = declaredPosition - this.logicalPosition[axis];
        clone.physicalOffset[axis] = this.physicalOffset[axis] - delta;
        clone.logicalPosition[axis] = declaredPosition;
      }
    }

    if ('E' in args) {
      const declaredExtrusion = args.E;
      const delta = declaredExtrusion - this.extrusion;
      clone.physicalEOffset = this.physicalEOffset - delta;
      clone.extrusion = declaredExtrusion;
    }

    return clone;
  }

  executeSetPositionModeCommand(command: SimpleCommand): GcodeVm {
    const clone = this.clone();
    switch (command.command) {
      case 'G90':
        clone.positionMode = 'absolute';
        break;
      case 'G91':
        clone.positionMode = 'relative';
        break;
    }
    return clone;
  }

  executeHomeCommand(command: SimpleCommand): GcodeVm {
    // Note that arguments in this case are all 0 if set, so we test membership
    // in this method.
    const { args } = command;
    // TODO: To support this, we'd need to track whether each axis has been
    // homed. I haven't seen this form in practice.
    if ('0' in args)
      throw new Error(
        "G28 0 is not supported; VM cannot determine 'trusted' axes",
      );

    const clone = this.clone();
    for (const axis of ['x', 'y', 'z'] as const) {
      if (axis.toUpperCase() in args) {
        clone.physicalOffset[axis] = 0;
      }
    }
    return clone;
  }

  executeArcCommand(): GcodeVm {
    const clone = this.clone();
    clone.logicalPosition.x = Infinity;
    clone.logicalPosition.y = Infinity;
    return clone;
  }

  executeMoveCommand(command: SimpleCommand): GcodeVm {
    const clone = this.clone();
    const { args } = command;
    switch (this.positionMode) {
      case 'absolute':
        clone.logicalPosition = new Point(
          args.X ?? this.logicalPosition.x,
          args.Y ?? this.logicalPosition.y,
          args.Z ?? this.logicalPosition.z,
        );
        break;
      case 'relative':
        clone.logicalPosition = this.logicalPosition.addVector([
          args.X ?? 0,
          args.Y ?? 0,
          args.Z ?? 0,
        ]);
        break;
    }

    switch (this.extrusionMode) {
      case 'absolute':
        clone.extrusion = args.E ?? this.extrusion;
        break;
      case 'relative':
        clone.extrusion += args.E ?? 0;
        break;
    }

    clone.didExtrudeOnLastMove = this.extrusion < clone.extrusion;

    return clone;
  }

  clone(): GcodeVm {
    const clone = Object.assign(new GcodeVm(), this);
    // Clone all point properties
    clone.logicalPosition = this.logicalPosition.clone();
    clone.physicalOffset = this.physicalOffset.clone();

    return clone;
  }
}

export type MoveMode = 'absolute' | 'relative';
