import { cmd, codes } from './GcodeCommand';
import { GcodeVm } from './GcodeVm';
import { Point } from './util';

describe('GcodeVm', () => {
  describe('setPosition', () => {
    it('should keep the physical position the same when setting position', () => {
      let vm = new GcodeVm();
      vm = vm.executeLine('G28');
      vm = vm.executeLine('G0 X10 Y10 Z10');
      // Set the position to 10, 5
      const nextVm = vm.executeLine('G92 X11 Y5');

      expect(nextVm.physicalPosition).toEqual(vm.physicalPosition);
      // Make sure that this isn't just an immutability failure
      expect(nextVm.logicalPosition).not.toEqual(vm.logicalPosition);
      expect(nextVm.logicalPosition).toEqual(new Point(11, 5, 10));
    });

    it('should keep physical extrusion the same when setting position', () => {
      let vm = new GcodeVm();
      vm = vm.executeLine('G28');
      vm = vm.executeLine('G0 X10 Y10 Z10 E4');
      // Set the position to 10, 5
      const nextVm = vm.executeLine('G92 E10');

      expect(nextVm.logicalPosition).toEqual(vm.logicalPosition);
      expect(nextVm.physicalPosition).toEqual(vm.physicalPosition);
      expect(nextVm.physicalExtrusion).toEqual(vm.physicalExtrusion);
      // Make sure that this isn't just an immutability failure
      expect(nextVm.extrusion).not.toEqual(vm.extrusion);
      expect(nextVm.extrusion).toEqual(10);
    });
  });

  describe('Movement', () => {
    it('should track state across multiple moves', () => {
      let vm = new GcodeVm();
      vm = vm.executeLine(codes.home);
      // Absolute positioning and relative extrusion
      vm = vm.executeLine(codes.absolute);
      vm = vm.executeLine(codes.eRelative);

      // Move just the X axis
      vm = vm.executeLine(cmd.rapidMove`X10`);
      expect(vm.logicalPosition).toEqual(new Point(10, 0, 0));
      expect(vm.physicalPosition).toEqual(new Point(10, 0, 0));
      expect(vm.didExtrudeOnLastMove).toEqual(false);

      // Extrude a line
      vm = vm.executeLine(cmd.linearMove`X20 Y10 E10`);
      expect(vm.logicalPosition).toEqual(new Point(20, 10, 0));
      expect(vm.physicalPosition).toEqual(new Point(20, 10, 0));
      expect(vm.physicalExtrusion).toEqual(10);
      expect(vm.didExtrudeOnLastMove).toEqual(true);

      // Reset relative extrusion
      vm = vm.executeLine(cmd.setPosition`E0`);
      vm = vm.executeLine(cmd.linearMove`X30 Z2 E10`);
      expect(vm.logicalPosition).toEqual(new Point(30, 10, 2));
      expect(vm.physicalPosition).toEqual(new Point(30, 10, 2));
      expect(vm.physicalExtrusion).toEqual(20);
      expect(vm.didExtrudeOnLastMove).toEqual(true);

      // Move just the Y axis
      vm = vm.executeLine(cmd.linearMove`Y20`);
      expect(vm.logicalPosition).toEqual(new Point(30, 20, 2));
      expect(vm.physicalPosition).toEqual(new Point(30, 20, 2));
      expect(vm.physicalExtrusion).toEqual(20);
      expect(vm.didExtrudeOnLastMove).toEqual(false);
    });
  });
});
