// The following codes are prohibited from gcode files because if not handled
// carefully, they could cause the nozzle to crash into the bed or other
// terrible possibilities.

export const prohibitedCodes = {
  G60: 'Save current position',
  G61: 'Restore saved position',
};

export const moveCodes = ['G0', 'G1'];
export const arcCodes = ['G2', 'G3'];

export function isMove(command: string) {
  return moveCodes.includes(command);
}

export function isArc(command: string) {
  return arcCodes.includes(command);
}

export const absoluteMode = 'G90';
export const relativeMode = 'G91';
export const printProgress = 'M73';
