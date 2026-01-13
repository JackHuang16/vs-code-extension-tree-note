export const window = {
  showInformationMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(),
    show: jest.fn(),
  })),
  withProgress: jest.fn(),
  showQuickPick: jest.fn(),
  showInputBox: jest.fn(),
};

export const workspace = {
  getConfiguration: jest.fn(() => ({
    get: jest.fn(),
    update: jest.fn(),
  })),
  onDidSaveTextDocument: jest.fn(),
};

export const authentication = {
  getSession: jest.fn(),
};

export const commands = {
  registerCommand: jest.fn(),
  executeCommand: jest.fn(),
};

export const EventEmitter = jest.fn().mockImplementation(() => ({
  fire: jest.fn(),
  event: jest.fn(),
}));

export const TreeItem = jest.fn();
export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

export const Uri = {
  file: jest.fn((path) => ({ fsPath: path })),
  parse: jest.fn((url) => ({ fsPath: url })),
};

export const Range = jest.fn();
export const Position = jest.fn();
export const Selection = jest.fn();
export const ThemeIcon = jest.fn();

export const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
};
