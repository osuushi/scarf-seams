export type SimpleCommand = {
  type: 'simple';
  command: SimpleCommandCode;
  args: Record<string, number>;
  comment?: string;
};

export type CommentCommand = {
  type: 'comment';
  comment: string;
};

// These are unsupported commands which are simply ignored by the VM
export type UnknownCommand = {
  type: 'unknown';
  content: string;
};

export type GcodeCommand = SimpleCommand | CommentCommand | UnknownCommand;

export const codes = {
  rapidMove: 'G0',
  linearMove: 'G1',
  cwArc: 'G2',
  ccwArc: 'G3',
  home: 'G28',
  absolute: 'G90',
  relative: 'G91',
  setPosition: 'G92',
  resetPositionToNative: 'G92.1',
  eAbsolute: 'M82',
  eRelative: 'M83',
} as const;

// Template tags for supported Gcode commands, just to make code more readable,
// particularly in tests.
export const cmd = Object.fromEntries(
  Object.entries(codes).map(([codeName, code]) => [
    codeName,
    (strings: TemplateStringsArray, ...args: unknown[]) => {
      const suffix = String.raw(strings, ...args);
      return `${code} ${suffix}`;
    },
  ]),
) as Record<
  keyof typeof codes,
  (strings: TemplateStringsArray, ...args: unknown[]) => string
>;

// We have to specify the commands we actually care about as "simples", because
// vendor specific codes can parse completely differently from standard codes.
// For example, Bambulab has an undocumented M1002 command which takes arbitrary
// strings as arguments. There are plenty of other codes which do use the
// standard argument format, which we don't bother supporting, since those will
// behave fine if passed through directly.
export const simpleCommandCodes = Object.values(codes);

export type SimpleCommandCode = (typeof simpleCommandCodes)[number];

export function parseCommand(
  gcodeLine: string,
): SimpleCommand | CommentCommand | UnknownCommand {
  if (gcodeLine.startsWith(';')) {
    return {
      type: 'comment',
      comment: gcodeLine.slice(1),
    };
  }

  const maybeSimpleCommandCode = tryGetSimpleCommandCodeFromLine(gcodeLine);
  if (maybeSimpleCommandCode != null) {
    const commandCode = maybeSimpleCommandCode;
    const [beforeComment, ...commentParts] = gcodeLine.split(';');
    const commandParts = beforeComment.split(/\s+/);
    const parsedArgs: Record<string, number> = {};
    for (const arg of commandParts.slice(1)) {
      const key = arg[0];
      const value = Number(arg.slice(1));
      parsedArgs[key] = value;
    }

    // G92.1 is a special case for "reset to native"
    if (commandCode === 'G92.1') {
      parsedArgs.X = 0;
      parsedArgs.Y = 0;
      parsedArgs.Z = 0;
    }

    return {
      type: 'simple',
      command: commandCode,
      args: parsedArgs,
      comment: commentParts.join(';'),
    };
  }

  return {
    type: 'unknown',
    content: gcodeLine,
  };
}

export function stringifyCommand(command: GcodeCommand): string {
  switch (command.type) {
    case 'comment':
      return stringifyCommentCommand(command);
    case 'simple':
      return stringifySimpleCommand(command);
    case 'unknown':
      return stringifyUnknownCommand(command);
  }
}

const simpleCommandRegex = /^\s*([A-Z][0-9.]+)\b/;
function tryGetSimpleCommandCodeFromLine(
  line: string,
): SimpleCommandCode | null {
  const match = line.match(simpleCommandRegex);

  if (!match) {
    return null;
  }

  if (!simpleCommandCodes.includes(match[1] as SimpleCommandCode)) {
    return null;
  }

  return match[1] as SimpleCommandCode;
}

function stringifyCommentCommand(command: CommentCommand): string {
  return `;${command.comment}`;
}

function stringifyUnknownCommand(command: UnknownCommand): string {
  return command.content;
}

function stringifySimpleCommand(command: SimpleCommand): string {
  const argStrings = Object.entries(command.args ?? {}).map(([key, value]) => {
    let precision;
    switch (key) {
      case 'X':
      case 'Y':
      case 'Z':
        precision = 3;
        break;
      case 'E':
        precision = 5;
        break;
      default:
        precision = 0;
    }
    return `${key}${value.toFixed(precision)}`;
  });
  return `${command.command} ${argStrings.join(' ')}${
    command.comment ? `;${command.comment}` : ''
  }`;
}
