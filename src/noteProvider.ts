import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export class NoteProvider implements vscode.TreeDataProvider<NoteItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    NoteItem | undefined | void
  > = new vscode.EventEmitter<NoteItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<NoteItem | undefined | void> =
    this._onDidChangeTreeData.event;

  constructor(private workspaceRoot: string | undefined) {}

  refresh(element?: NoteItem): void {
    this._onDidChangeTreeData.fire(element);
  }

  getTreeItem(element: NoteItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: NoteItem): Thenable<NoteItem[]> {
    if (!this.workspaceRoot) {
      return Promise.resolve([]);
    }

    if (element) {
      if (!element.dirPath) {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        this.getNotesInDir(element.dirPath, element.depth + 1)
      );
    } else {
      return Promise.resolve(this.getNotesInDir(this.workspaceRoot, 1));
    }
  }

  // --- CRITICAL FOR REVEAL / EXPAND ALL ---
  getParent(element: NoteItem): vscode.ProviderResult<NoteItem> {
    if (!this.workspaceRoot) {
      return null;
    }

    // Identify the current path
    const currentPath = element.fsPath || element.dirPath;
    if (!currentPath) {
      return null;
    }

    const parentPath = path.dirname(currentPath);

    // If parent is the workspace root, return null (VS Code handles root)
    if (parentPath === this.workspaceRoot) {
      return null;
    }

    // Reconstruct the parent NoteItem
    // Use the same logic as getNotesInDir
    const name = path.basename(parentPath);
    const mdPath = parentPath + ".md";

    let fsPath: string | undefined = undefined;
    if (fs.existsSync(mdPath) && fs.statSync(mdPath).isFile()) {
      fsPath = mdPath;
    }

    let dirPath: string | undefined = undefined;
    if (fs.existsSync(parentPath) && fs.statSync(parentPath).isDirectory()) {
      dirPath = parentPath;
    }

    // Depth calculation
    const relativePath = path.relative(this.workspaceRoot, parentPath);
    const depth = relativePath === "" ? 0 : relativePath.split(path.sep).length;

    return new NoteItem(
      name,
      vscode.TreeItemCollapsibleState.Collapsed,
      fsPath,
      dirPath,
      depth
    );
  }

  // Exposed for extension.ts to use in expandAll recursion
  public async getChildrenAsync(element?: NoteItem): Promise<NoteItem[]> {
    return this.getChildren(element);
  }

  private getNotesInDir(dirPath: string, currentDepth: number): NoteItem[] {
    if (!pathExists(dirPath)) {
      return [];
    }

    const files = fs.readdirSync(dirPath);
    const items: NoteItem[] = [];

    files.forEach((file) => {
      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        items.push(
          new NoteItem(
            file,
            vscode.TreeItemCollapsibleState.Collapsed,
            undefined,
            fullPath,
            currentDepth
          )
        );
      } else if (path.extname(file).toLowerCase() === ".md") {
        const name = path.basename(file, ".md");
        items.push(
          new NoteItem(
            name,
            vscode.TreeItemCollapsibleState.None,
            fullPath,
            undefined,
            currentDepth
          )
        );
      }
    });

    items.sort((a, b) => {
      // Sort: Folders first, then Files
      if (a.dirPath && !b.dirPath) return -1;
      if (!a.dirPath && b.dirPath) return 1;
      return a.label.localeCompare(b.label);
    });
    return items;
  }
}

class NoteItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly fsPath?: string,
    public readonly dirPath?: string,
    public readonly depth: number = 0
  ) {
    super(label, collapsibleState);

    // Set ID to ensure stability for reveal/expand
    // Prefer dirPath as ID for containers, fsPath for files.
    // Ensure consistency with getParent reconstruction.
    this.id = dirPath || fsPath;

    this.tooltip = this.fsPath || this.dirPath;

    if (this.dirPath) {
      if (this.depth >= 3) {
        this.contextValue = "noteParentMax";
      } else {
        this.contextValue = "noteParent";
      }
    } else {
      this.contextValue = "noteChild";
    }

    if (fsPath) {
      this.resourceUri = vscode.Uri.file(fsPath);
      this.command = {
        command: "vscode.open",
        title: "Open Note",
        arguments: [this.resourceUri],
      };
    } else if (dirPath) {
      this.resourceUri = vscode.Uri.file(dirPath);
    }
  }
}

function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch (err) {
    return false;
  }
}
