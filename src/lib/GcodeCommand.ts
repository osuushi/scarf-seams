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

// We have to specify the commands we actually care about, because vendor
// specific codes can parse completely differently from standard codes. For
// example, Bambulab has an undocumented M1002 command which takes arbitrary
// strings as arguments.
export const simpleCommandCodes = [
  'G0',
  'G1',
  'G2',
  'G3',
  'G28',
  'G90',
  'G91',
  'G92',
  'G92.1',
  'M82',
  'M83',
] as const;

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

  if (simpleCommandCodes.some((code) => gcodeLine.startsWith(`${code} `))) {
    const [beforeComment, ...commentParts] = gcodeLine.split(';');
    const commandParts = beforeComment.split(/\s+/);
    const commandName = commandParts[0] as SimpleCommandCode; // typescript can't tell that we've filtered to this
    const parsedArgs: Record<string, number> = {};
    for (const arg of commandParts.slice(1)) {
      const key = arg[0];
      const value = Number(arg.slice(1));
      parsedArgs[key] = value;
    }

    // G92.1 is a special case for "reset to native"
    if (commandName === 'G92.1') {
      parsedArgs.X = 0;
      parsedArgs.Y = 0;
      parsedArgs.Z = 0;
    }

    return {
      type: 'simple',
      command: commandName,
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
