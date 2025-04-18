// VS Code拡張機能: メモ機能 + Gitブランチ対応
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as crypto from 'crypto';
import * as promiseFs from 'fs/promises';
import * as fs from 'fs';
import * as chokidar from 'chokidar';

const TARGET_BRANCH = "mori"; // このブランチの時だけ機能ON

const STORAGE_NAME = ".mori";
const GIT_API_VERSION = 1;
const CURRENT_REPOSITORY = 0;

let WORKSPACE_PATH = "";
let STORAGE_PATH = "";
let currentBranchName = "";
let watcher: chokidar.FSWatcher | null = null;

const stateChanged = new EventEmitter();
const memo: Map<string, string> = new Map();

let memoDecorationType: vscode.TextEditorDecorationType;

const setMemo = (callback: () => void) => {
	callback();
	stateChanged.emit("update");
};

stateChanged.on("update", () => {
	const editor = vscode.window.activeTextEditor;
	if (editor) applyDecorations(editor);
});

const getSha1 = (text: string): string => {
  	return crypto.createHash("sha1").update(text).digest("hex");
};

const getStoragePath = () => path.join(WORKSPACE_PATH, STORAGE_NAME);

const loadMemo = () => {
	memo.clear();
	const entries = fs.readdirSync(STORAGE_PATH, { withFileTypes: true });
	entries.filter(e => e.isFile()).forEach(entry => {
		const content = fs.readFileSync(path.join(STORAGE_PATH, entry.name), 'utf8');
		memo.set(entry.name, content);
	});
};

const watchStorage = async () => {
	if (watcher) await watcher.close();
	watcher = chokidar.watch(STORAGE_PATH, { persistent: true, ignoreInitial: true });

	watcher
		.on('add', async (filePath) => {
			const content = fs.readFileSync(filePath, 'utf8');
			const name = path.basename(filePath);
			setMemo(() => memo.set(name, content));
		})
		.on('change', filePath => {
		const content = fs.readFileSync(filePath, 'utf8');
		const name = path.basename(filePath);
		setMemo(() => memo.set(name, content));
		})
		.on('unlink', filePath => {
		const name = path.basename(filePath);
		setMemo(() => memo.delete(name));
		})
		.on('error', error => console.error("🚨 監視エラー:", error));
};

const applyDecorations = (editor: vscode.TextEditor) => {
	if (!memoDecorationType) {
		memoDecorationType = vscode.window.createTextEditorDecorationType({});
	}
	
	editor.setDecorations(memoDecorationType, []);
	const decorations: vscode.DecorationOptions[] = [];

	for (let i = 0; i < editor.document.lineCount; i++) {
		const line = editor.document.lineAt(i);
		const hash = getSha1(line.text);
		const memoContent = memo.get(hash);

		if (memoContent) {
			decorations.push({
				range: new vscode.Range(i, line.range.end.character, i, line.range.end.character),
				renderOptions: {
					after: {
						contentText: ` 📌 ${memoContent.split('\n')[0]}`,
						color: "#888",
						margin: "0 0 10px"
					}
				}
			});
		}
	}
	editor.setDecorations(memoDecorationType, decorations);
};

const getMemo = (): Record<string, string> => {
	const res: Record<string, string> = {};
	const entries = fs.readdirSync(STORAGE_PATH, { withFileTypes: true });
	entries.filter(e => e.isFile()).forEach(entry => {
		res[entry.name] = fs.readFileSync(path.join(STORAGE_PATH, entry.name), 'utf8');
	});
	return res;
};

const createDocumentation = async (args: any) => {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const line = args?.line ?? editor.selection.active.line;
	const text = editor.document.lineAt(line).text;

	if (text.trim() === '') {
		vscode.window.showInformationMessage("⚠️ 空行にはドキュメントを作成できません");
		return;
	}
	
	const hash = getSha1(text);
	const contentPath = path.join(STORAGE_PATH, hash);

	const defaultContent = `#### title\n- Usage \n\n\`\`\`bash\n$  \n\`\`\`\n\n[✏️ 編集する](command:mori.editDocumentation?${encodeURIComponent(JSON.stringify({ line }))})\n[🗑️ 削除する](command:mori.deleteDocumentation?${encodeURIComponent(JSON.stringify({ line }))})\n`;

	if (!fs.existsSync(contentPath)) {
		await fs.promises.writeFile(contentPath, defaultContent, "utf8");
	}
	const doc = await vscode.workspace.openTextDocument(contentPath);
	await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
};

const editDocumentation = async (args: any) => {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const line = args?.line ?? editor.selection.active.line;
	const text = editor.document.lineAt(line).text;
	const hash = getSha1(text);
	const contentPath = path.join(STORAGE_PATH, hash);

	const doc = await vscode.workspace.openTextDocument(contentPath);
	await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
};

const deleteDocumentation = async (args: any) => {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const line = args?.line ?? editor.selection.active.line;
	const text = editor.document.lineAt(line).text;
	const hash = getSha1(text);
	const contentPath = path.join(STORAGE_PATH, hash);

	try {
		await fs.promises.unlink(contentPath);
		setMemo(() => memo.delete(hash));
	} catch (err) {
		console.log("削除失敗:", err);
	}
};

const hoverProvider: vscode.HoverProvider = {
	provideHover(document, position) {
		if (currentBranchName !== TARGET_BRANCH) return;

		const lineText = document.lineAt(position.line).text;
		const hash = getSha1(lineText);
		const memoState = getMemo();

		const cmd = `[📝 ドキュメントを作成](command:mori.createDocumentation?${encodeURIComponent(JSON.stringify({ line: position.line }))})`;
		const content = memoState[hash] || `📌 **この行の説明を作成しますか？**\n\n${cmd}`;

		const md = new vscode.MarkdownString();
		md.appendMarkdown(content);
		md.isTrusted = true;
		return new vscode.Hover(md);
	}
};

export const activate = async (context: vscode.ExtensionContext) => {
	const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
	const git = gitExtension?.getAPI(GIT_API_VERSION);
	const repo = git?.repositories?.[CURRENT_REPOSITORY];

	if (!repo) {
		vscode.window.showErrorMessage("Git リポジトリが見つかりません");
		return;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) return;
	WORKSPACE_PATH = workspaceFolders[0].uri.fsPath;

	const setupStorage = async (branch: string) => {
		currentBranchName = branch;
		STORAGE_PATH = getStoragePath();
		memo.clear(); // 💡 ここで毎回明示的にクリアすることで再ロード防止！
		await promiseFs.mkdir(STORAGE_PATH, { recursive: true });
		loadMemo();
		await watchStorage();
	};

	//   await setupStorage(repo.state.HEAD?.name ?? 'default');
	const initialBranch = repo.state.HEAD?.name ?? 'default';
	if (initialBranch === TARGET_BRANCH) {
		await setupStorage(initialBranch);
	}

	repo.state.onDidChange(async () => {
		const newBranch = repo.state.HEAD?.name ?? 'default';
		// 🚨 mori から抜けるときに未コミットチェック
		if (currentBranchName === TARGET_BRANCH && newBranch !== TARGET_BRANCH) {
			const isDirty = repo.state.workingTreeChanges.length > 0;
			if (isDirty) {
			vscode.window.showWarningMessage(
				`⚠️ '${TARGET_BRANCH}' ブランチに未コミットの変更があります！切り替えは非推奨です`);
			} else {
			vscode.window.showInformationMessage(`🔁 '${TARGET_BRANCH}' から '${newBranch}' に切り替わりました`);
			}
		}
  });

  context.subscriptions.push(
		vscode.commands.registerCommand('mymy.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from mymy!');
		}),
		vscode.commands.registerCommand('mori.createDocumentation', createDocumentation),
		vscode.commands.registerCommand('mori.editDocumentation', editDocumentation),
		vscode.commands.registerCommand('mori.deleteDocumentation', deleteDocumentation),
		vscode.languages.registerHoverProvider('*', hoverProvider),
		{ dispose: () => { if (watcher) watcher.close(); } }
	);

	vscode.workspace.onDidChangeTextDocument(event => {
		const editor = vscode.window.activeTextEditor;
		if (editor && event.document === editor.document) {
		applyDecorations(editor);
		}
	});

	vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor) applyDecorations(editor);
	});
};

export const deactivate = () => {
  	if (watcher) watcher.close();
};
