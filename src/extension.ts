import * as vscode from "vscode";
import { NoteProvider } from "./noteProvider";
import * as fs from "fs";
import * as path from "path";
import { GistService } from "./services/gistService";
import { LocalStateManager } from "./services/localStateManager";
import { SyncManager } from "./services/syncManager";

export function activate(context: vscode.ExtensionContext) {
  // Use globalStorageUri for persistent storage across workspaces
  const rootPath = path.join(context.globalStorageUri.fsPath, "notes-data");

  if (!fs.existsSync(rootPath)) {
    try {
      fs.mkdirSync(rootPath, { recursive: true });
    } catch (e) {}
  }

  // Initialize Services
  const gistService = new GistService();
  const localStateManager = new LocalStateManager(context);
  const syncManager = new SyncManager(gistService, localStateManager);

  const noteProvider = new NoteProvider(rootPath);

  const treeView = vscode.window.createTreeView("treeNoteView", {
    treeDataProvider: noteProvider,
    showCollapseAll: false, // We use our custom toggle
  });

  vscode.commands.executeCommand("setContext", "treeNote.allExpanded", false);
  vscode.commands.registerCommand("treeNote.refreshEntry", () =>
    noteProvider.refresh()
  );

  // === EXPAND / COLLAPSE (Refined) ===

  vscode.commands.registerCommand("treeNote.expandAll", async () => {
    // Expand depth: 3 levels deep as per requirements
    const depthToExpand = 3;
    try {
      const rootItems = await noteProvider.getChildrenAsync();
      for (const item of rootItems) {
        await treeView.reveal(item, {
          expand: depthToExpand,
          select: false,
          focus: false,
        });
      }
      vscode.commands.executeCommand(
        "setContext",
        "treeNote.allExpanded",
        true
      );
    } catch (e) {
      console.log("Expand Error:", e);
    }
  });

  vscode.commands.registerCommand("treeNote.collapseAll", async () => {
    vscode.commands.executeCommand(
      "workbench.actions.treeView.treeNoteView.collapseAll"
    );
    vscode.commands.executeCommand("setContext", "treeNote.allExpanded", false);
  });

  // === HELPER FUNCTIONS ===

  const validateName = (name: string): string | undefined => {
    const trimmed = name.trim();
    if (!trimmed) return "Name cannot be empty";
    if (trimmed.startsWith(".")) return "Name cannot start with a dot (.)";
    const invalidChars = /[\\/:\*\?"<>|]/;
    if (invalidChars.test(trimmed)) {
      return 'Name contains invalid characters (\\ / : * ? " < > |)';
    }
    return undefined;
  };

  // Improved Tree Generator: Simplified for variable-width fonts and strict 3-item limit
  // Simplified Tree Generator: Only first level, first 3 items, no expansion
  const generateDirectoryTree = (dirPath: string): string => {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory())
      return "";

    let result = "";
    const entries = fs.readdirSync(dirPath);
    const notes = new Set<string>();
    const folders = new Set<string>();

    entries.forEach((e) => {
      const full = path.join(dirPath, e);
      try {
        if (fs.statSync(full).isDirectory()) folders.add(e);
        else if (path.extname(e).toLowerCase() === ".md")
          notes.add(path.basename(e, ".md"));
      } catch (err) {}
    });

    const allNames = Array.from(new Set([...notes, ...folders])).sort((a, b) =>
      a.localeCompare(b)
    );

    const LIMIT = 3;
    const itemsToShow = allNames.slice(0, LIMIT);
    const remainingCount = allNames.length - LIMIT;

    for (let i = 0; i < itemsToShow.length; i++) {
      const name = itemsToShow[i];
      const isLast = i === itemsToShow.length - 1 && remainingCount === 0;
      const hasFolder = folders.has(name);

      const marker = isLast ? "└ " : "├ ";
      const icon = hasFolder ? "📁" : "📄";

      result += marker + icon + " " + name + "\n";
    }

    if (remainingCount > 0) {
      result += "└ ... (" + remainingCount + " more items)\n";
    }

    return result;
  };

  const createNoteCore = async (targetDir: string, parentNode?: any) => {
    const rawName = await vscode.window.showInputBox({
      placeHolder: "Enter note name",
      validateInput: validateName,
    });
    const fileName = rawName?.trim();
    if (!fileName) return;

    const newFilePath = path.join(targetDir, `${fileName}.md`);
    if (fs.existsSync(newFilePath)) {
      vscode.window.showErrorMessage(`Note '${fileName}' already exists!`);
      return;
    }

    fs.writeFileSync(newFilePath, "");
    noteProvider.refresh();

    if (parentNode) {
      setTimeout(() => {
        try {
          treeView.reveal(parentNode, {
            expand: true,
            select: false,
            focus: false,
          });
        } catch (e) {}
      }, 100);
    }

    vscode.window.showTextDocument(vscode.Uri.file(newFilePath));
  };

  const createFolderCore = async (targetDir: string, parentNode?: any) => {
    const rawName = await vscode.window.showInputBox({
      placeHolder: "Enter folder name",
      validateInput: validateName,
    });
    const folderName = rawName?.trim();
    if (!folderName) return;

    const newFolderPath = path.join(targetDir, folderName);
    if (fs.existsSync(newFolderPath)) {
      vscode.window.showErrorMessage(`Folder '${folderName}' already exists!`);
      return;
    }

    fs.mkdirSync(newFolderPath);
    noteProvider.refresh();

    if (parentNode) {
      setTimeout(() => {
        try {
          treeView.reveal(parentNode, {
            expand: true,
            select: false,
            focus: false,
          });
        } catch (e) {}
      }, 100);
    }
  };

  // === COMMANDS ===
  vscode.commands.registerCommand("treeNote.addRootNote", async () => {
    await createNoteCore(rootPath);
  });
  vscode.commands.registerCommand("treeNote.addRootFolder", async () => {
    await createFolderCore(rootPath);
  });
  vscode.commands.registerCommand("treeNote.addNote", async (node: any) => {
    let targetDir = rootPath;
    if (node && node.dirPath) {
      targetDir = node.dirPath;
    }
    await createNoteCore(targetDir, node);
  });
  vscode.commands.registerCommand("treeNote.addFolder", async (node: any) => {
    if (node && typeof node.depth === "number" && node.depth >= 3) {
      vscode.window.showErrorMessage("Maximum folder depth (3) reached.");
      return;
    }
    let targetDir = rootPath;
    if (node && node.dirPath) {
      targetDir = node.dirPath;
    }
    await createFolderCore(targetDir, node);
  });
  vscode.commands.registerCommand("treeNote.syncToGist", async () => {
    await syncManager.sync(rootPath);
  });
  vscode.commands.registerCommand("treeNote.deleteNote", async (node: any) => {
    if (!node) return;
    let message = `Delete '${node.label}'?`;
    let detail = "";
    if (node.dirPath && fs.existsSync(node.dirPath)) {
      message = `Delete '${node.label}' and all its contents?`;
      const childrenTree = generateDirectoryTree(node.dirPath);
      // Use the target folder as the root of the preview tree
      detail =
        `Warning: This will permanently delete:\n\n` +
        `📁 ${node.label}\n` +
        (childrenTree
          ? childrenTree
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => "  " + line)
              .join("\n") + "\n"
          : "");
    }
    const answer = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail: detail },
      "Delete"
    );
    if (answer === "Delete") {
      try {
        if (node.fsPath && fs.existsSync(node.fsPath)) {
          fs.unlinkSync(node.fsPath);
          localStateManager.handleFileDelete(node.fsPath);
        }
        if (node.dirPath && fs.existsSync(node.dirPath))
          fs.rmSync(node.dirPath, { recursive: true, force: true });
        noteProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  });
  vscode.commands.registerCommand("treeNote.renameNote", async (node: any) => {
    if (!node) return;
    const oldName = node.label;
    const rawName = await vscode.window.showInputBox({
      value: oldName,
      validateInput: validateName,
    });
    const newName = rawName?.trim();
    if (newName && newName !== oldName) {
      try {
        if (node.fsPath) {
          const newPath = path.join(path.dirname(node.fsPath), `${newName}.md`);
          if (fs.existsSync(newPath))
            return vscode.window.showErrorMessage("Name exists!");
          fs.renameSync(node.fsPath, newPath);
          localStateManager.handleFileRename(node.fsPath, newPath);
        } else if (node.dirPath && fs.existsSync(node.dirPath)) {
          const newDirPath = path.join(path.dirname(node.dirPath), newName);
          if (fs.existsSync(newDirPath))
            return vscode.window.showErrorMessage("Name exists!");
          fs.renameSync(node.dirPath, newDirPath);
        }
        noteProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  });
}

export function deactivate() {}
