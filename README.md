[中文版](#tree-note) | [English](#tree-note-english)

# Tree Note

**Tree Note** 是一款為 VS Code 量身打造的層級式筆記管理擴充功能。它採用直觀的「A+B 節點配對邏輯」，讓您的 Markdown 筆記與資料夾結構完美融合，提供如原生檔案總管般流暢的樹狀筆記體驗。

## ✨ 主要特色

### 1. 層級式筆記結構

- **清晰的目錄管理**：支援資料夾與 Markdown 筆記的層級式排列，讓您的筆記結構一目了然。
- **直觀導覽**：您可以自由建立、組織並切換不同的筆記與資料夾。

### 2. 強大的樹狀操作

- **快速新增**：一鍵新增根目錄或子層級的筆記與資料夾。
- **自動展開**：建立新項目後，系統會自動展開父資料夾，確保您能立即看到結果。
- **全局控制**：支援標題列的一鍵「全部展開」與「全部縮合」功能。

### 3. 安全與資料誠信

- **智慧刪除確認**：刪除資料夾時，會顯示清晰的樹狀預覽（最多顯示 3 個項目），分層呈現即將被移除的內容，防止誤刪。
- **輸入驗證系統**：
  - 自動修剪（Trim）名稱前後的空白。
  - 即時阻擋非法字元（如 `/ \ : * ? " < > |`）。
  - 禁止建立以 `.` 開頭的隱藏檔案，確保檔案管理的一致性。

### 4. 深度限制

- 預設支援最高 **3 層** 的資料夾深度，協助您保持筆記結構的簡潔與可讀性，避免過度嵌套。

## 🚀 快速上手

1. **安裝套件**：在 VS Code 中載入本擴充功能。
2. **開啟檢視器**：在側邊欄「檔案總管 (Explorer)」下方找到「Tree Note」區塊。
3. **管理筆記**：
   - 使用標題列的圖示與新增文件或資料夾開始建立結構。
   - 資料存放路徑固定於 VS Code 的全域儲存目錄中，確保您的筆記在不同專案間都能持續存取。

## 🛠 指令列表 (Commands)

| 指令                    | 說明                           |
| ----------------------- | ------------------------------ |
| `treeNote.refreshEntry` | 重新讀取檔案系統並更新樹狀圖。 |
| `treeNote.expandAll`    | 將所有資料夾展開至第 3 層。    |
| `treeNote.collapseAll`  | 折疊所有開啟的資料夾。         |
| `treeNote.renameNote`   | 重新命名筆記或資料夾。         |

## 📦 資料存放

所有的筆記預設存在套件的全局儲存路徑中，這確保您的筆記在不同專案間都能持續存取。
您可以在 VS Code 的全域儲存目錄中找到 `notes-data` 資料夾。

---

**Tree Note** - 讓您的思考層次分明，管理筆記不再混亂。

---

# Tree Note (English)

**Tree Note** is a hierarchical note-taking extension tailored for VS Code. It utilizes an intuitive "A+B Node Pairing Logic," allowing your Markdown notes and folder structures to merge seamlessly, providing a smooth tree-like note-taking experience similar to the native file explorer.

## ✨ Key Features

### 1. Hierarchical Note Structure

- **Clear Organization**: Support for a tree-like hierarchy of folders and Markdown notes, making your structure easy to understand.
- **Intuitive Navigation**: Easily create, organize, and navigate through your notes and folders.

### 2. Powerful Tree Operations

- **Quick Creation**: Add root-level or nested notes and folders with a single click.
- **Auto-Expansion**: After creating a new item, the system automatically expands the parent folder to provide immediate visual feedback.
- **Global Control**: Supports one-click "Expand All" and "Collapse All" functionality from the title bar.

### 3. Safety & Data Integrity

- **Smart Delete Confirmation**: When deleting folders, a clear tree preview (up to 3 items) is shown to display the hierarchy of contents being removed, preventing accidental data loss.
- **Input Validation System**:
  - Automatic trimming of leading and trailing whitespace.
  - Real-time blocking of illegal characters (e.g., `/ \ : * ? " < > |`).
  - Prohibition of hidden files (starting with `.`) to ensure consistent file management.

### 4. Depth Limitation

- Supports a maximum folder depth of **3 layers** by default, helping you keep your note structure clean, readable, and avoiding over-nesting.

## 🚀 Getting Started

1. **Install the Extension**: Load this extension in VS Code.
2. **Open the View**: Find the "Tree Note" section at the bottom of the "Explorer" sidebar.
3. **Manage Notes**:
   - Use the icons in the title bar to start building your structure.
   - All data is stored in VS Code's global storage directory, ensuring your notes persist across different workspaces.

## 🛠 Commands

| Command                 | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `treeNote.refreshEntry` | Reload the file system and update the tree view. |
| `treeNote.expandAll`    | Expand all folders up to 3 layers deep.          |
| `treeNote.collapseAll`  | Collapse all open folders.                       |
| `treeNote.renameNote`   | Rename notes or folders.                         |

## 📦 Data Storage

All notes are stored by default in the extension's global storage path, ensuring your notes persist across different workspaces.
You can find the `notes-data` folder within VS Code's global storage directory.

---

**Tree Note** - Keep your thoughts organized and your navigation effortless.
