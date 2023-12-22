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
});
